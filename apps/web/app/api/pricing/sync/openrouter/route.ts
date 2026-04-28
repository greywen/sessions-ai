import { NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/lib/db';
import { auditLogs, pricingTable } from '@/lib/db/schema';
import { getSession } from '@/lib/auth/session';
import { hasRole } from '@/lib/auth/roles';
import { logger } from '@/lib/logger';
import { ensurePricingSyncSchema } from '@/lib/db/pricing-sync-schema';

const OPENROUTER_MODELS_URL = process.env.OPENROUTER_MODELS_URL || 'https://openrouter.ai/api/v1/models';

const openRouterResponseSchema = z.object({
  data: z.array(z.object({
    id: z.string().min(1),
    pricing: z.object({
      prompt: z.string().optional(),
      completion: z.string().optional(),
      input_cache_read: z.string().optional(),
      input_cache_write: z.string().optional(),
    }).passthrough().optional(),
  }).passthrough()),
});

interface SyncCandidate {
  provider: string;
  model: string;
  inputPricePerMtok: string;
  outputPricePerMtok: string;
  cachePricePerMtok: string | null;
  sourceModelId: string;
}

function parseProviderAndModel(rawModelId: string): { provider: string; model: string } | null {
  const normalized = rawModelId.trim().replace(/^~/, '');
  if (!normalized) return null;
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const provider = parts[0].toLowerCase();
  const model = parts.slice(1).join('/');
  if (!provider || !model) return null;
  return { provider, model };
}

function tokenPriceToMtok(rawPrice?: string): string | null {
  if (rawPrice == null) return null;
  const value = Number(rawPrice);
  if (!Number.isFinite(value) || value < 0) return null;
  return (value * 1_000_000).toFixed(4);
}

function dedupeCandidates(items: z.infer<typeof openRouterResponseSchema>['data']): {
  candidates: SyncCandidate[];
  skippedInvalid: number;
} {
  const map = new Map<string, SyncCandidate>();
  let skippedInvalid = 0;

  for (const item of items) {
    const parsed = parseProviderAndModel(item.id);
    if (!parsed) {
      skippedInvalid += 1;
      continue;
    }

    const input = tokenPriceToMtok(item.pricing?.prompt);
    const output = tokenPriceToMtok(item.pricing?.completion);
    if (input == null || output == null) {
      skippedInvalid += 1;
      continue;
    }

    const cacheWrite = tokenPriceToMtok(item.pricing?.input_cache_write);
    const cacheRead = tokenPriceToMtok(item.pricing?.input_cache_read);
    const cache = cacheWrite ?? cacheRead ?? null;
    const key = parsed.model;

    const nextCandidate: SyncCandidate = {
      provider: parsed.provider,
      model: parsed.model,
      inputPricePerMtok: input,
      outputPricePerMtok: output,
      cachePricePerMtok: cache,
      sourceModelId: item.id,
    };

    const existing = map.get(key);
    if (!existing) {
      map.set(key, nextCandidate);
      continue;
    }

    // Prefer non-alias ids (without leading "~") when duplicates exist.
    if (existing.sourceModelId.startsWith('~') && !item.id.startsWith('~')) {
      map.set(key, nextCandidate);
    }
  }

  return { candidates: Array.from(map.values()), skippedInvalid };
}

function chunk<T>(arr: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size));
  }
  return result;
}

// POST /api/pricing/sync/openrouter - Sync pricing table from OpenRouter
export async function POST() {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: 'not_logged_in' }, { status: 401 });
    }
    if (!hasRole(session.role, 'admin')) {
      return NextResponse.json({ error: 'Insufficient Permissions' }, { status: 403 });
    }

    await ensurePricingSyncSchema();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    let payload: z.infer<typeof openRouterResponseSchema>;
    let responseData: unknown;

    try {
      const response = await fetch(OPENROUTER_MODELS_URL, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'User-Agent': 'sessions-ai-pricing-sync',
        },
        cache: 'no-store',
        signal: controller.signal,
      });

      if (!response.ok) {
        logger.warn({ status: response.status }, 'OpenRouter pricing sync request failed');
        return NextResponse.json(
          { error: `OpenRouter sync failed with status ${response.status}` },
          { status: 502 },
        );
      }

      responseData = await response.json();
    } catch (error) {
      logger.warn(
        {
          error: error instanceof Error ? { name: error.name, message: error.message } : String(error),
        },
        'OpenRouter pricing sync fetch error',
      );
      return NextResponse.json(
        { error: 'OpenRouter sync request failed. Please retry or configure OPENROUTER_MODELS_URL.' },
        { status: 502 },
      );
    } finally {
      clearTimeout(timeout);
    }
    payload = openRouterResponseSchema.parse(responseData);

    const { candidates, skippedInvalid } = dedupeCandidates(payload.data);
    const now = new Date();
    const effectiveFrom = now.toISOString().slice(0, 10);

    if (candidates.length === 0) {
      return NextResponse.json({
        data: {
          fetched: payload.data.length,
          inserted: 0,
          updated: 0,
          skippedLocked: 0,
          skippedInvalid,
          effectiveFrom,
        },
      });
    }

    const latestRows = await db.execute(sql`
      SELECT DISTINCT ON (model)
        provider,
        model,
        effective_from,
        sync_locked
      FROM pricing_table
      ORDER BY model, effective_from DESC, created_at DESC
    `);
    const lockedModels = new Set<string>();
    const existingModels = new Set<string>();
    for (const row of latestRows as Array<Record<string, unknown>>) {
      const model = String(row.model);
      existingModels.add(model);
      if (row.sync_locked === true) {
        lockedModels.add(model);
      }
    }

    const upsertValues: Array<typeof pricingTable.$inferInsert> = [];
    let inserted = 0;
    let updated = 0;
    let skippedLocked = 0;

    for (const item of candidates) {
      if (lockedModels.has(item.model)) {
        skippedLocked += 1;
        continue;
      }

      if (existingModels.has(item.model)) updated += 1;
      else inserted += 1;

      upsertValues.push({
        provider: item.provider,
        model: item.model,
        inputPricePerMtok: item.inputPricePerMtok,
        outputPricePerMtok: item.outputPricePerMtok,
        cachePricePerMtok: item.cachePricePerMtok,
        effectiveFrom,
        effectiveTo: null,
        syncSource: 'openrouter',
        syncLocked: false,
        lastSyncedAt: now,
      });
    }

    if (upsertValues.length > 0) {
      for (const valuesChunk of chunk(upsertValues, 200)) {
        await db
          .insert(pricingTable)
          .values(valuesChunk)
          .onConflictDoUpdate({
            target: [pricingTable.model],
            set: {
              provider: sql`excluded.provider`,
              inputPricePerMtok: sql`excluded.input_price_per_mtok`,
              outputPricePerMtok: sql`excluded.output_price_per_mtok`,
              cachePricePerMtok: sql`excluded.cache_price_per_mtok`,
              effectiveFrom: sql`excluded.effective_from`,
              effectiveTo: null,
              syncSource: sql`excluded.sync_source`,
              syncLocked: false,
              lastSyncedAt: sql`excluded.last_synced_at`,
            },
          });
      }
    }

    let auditLogged = false;
    try {
      await db.insert(auditLogs).values({
        userId: session.userId,
        action: 'pricing_sync_openrouter',
        targetType: 'pricing',
        details: {
          fetched: payload.data.length,
          inserted,
          updated,
          skippedLocked,
          skippedInvalid,
          effectiveFrom,
        },
      });
      auditLogged = true;
    } catch (auditError) {
      logger.warn(
        {
          userId: session.userId,
          error: auditError instanceof Error ? { name: auditError.name, message: auditError.message } : String(auditError),
        },
        'OpenRouter pricing sync audit log failed',
      );
    }

    logger.info(
      {
        userId: session.userId,
        fetched: payload.data.length,
        inserted,
        updated,
        skippedLocked,
        skippedInvalid,
        effectiveFrom,
        auditLogged,
      },
      'OpenRouter pricing sync finished',
    );

    return NextResponse.json({
      data: {
        fetched: payload.data.length,
        inserted,
        updated,
        skippedLocked,
        skippedInvalid,
        effectiveFrom,
        auditLogged,
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'OpenRouter response validation failed', details: error.issues },
        { status: 502 },
      );
    }
    logger.error({ error }, 'OpenRouter pricing sync exception');
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
