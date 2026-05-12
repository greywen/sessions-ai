import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getSession } from '@/lib/auth/session';
import { hasRole } from '@/lib/auth/roles';
import { logger } from '@/lib/logger';
import { sql } from 'drizzle-orm';

/**
 * POST /api/admin/recompute-costs
 *
 * Recompute normalized_messages.cost_usd from token usage using static prices
 * configured by environment variables:
 *   - COST_INPUT_PRICE_PER_MTOK
 *   - COST_OUTPUT_PRICE_PER_MTOK
 *   - COST_CACHE_PRICE_PER_MTOK
 *
 * Security: admin session or CRON_SECRET.
 *
 * Optional query: ?from=YYYY-MM-DD&to=YYYY-MM-DD to limit the range
 * (defaults to full-table recompute).
 */
export async function POST(request: Request) {
  // Authentication
  const cronSecret = request.headers.get('x-cron-secret');
  const expectedSecret = process.env.CRON_SECRET || 'sessions-ai-cron-secret';
  if (cronSecret !== expectedSecret) {
    const session = await getSession();
    if (!session || !hasRole(session.role, 'admin')) {
      return NextResponse.json({ error: 'Not Authorised' }, { status: 401 });
    }
  }

  const { searchParams } = new URL(request.url);
  const from = searchParams.get('from');
  const to = searchParams.get('to');

  const parsePrice = (raw: string | undefined) => {
    const value = Number(raw ?? '0');
    return Number.isFinite(value) && value >= 0 ? value : 0;
  };

  const inputPricePerMtok = parsePrice(process.env.COST_INPUT_PRICE_PER_MTOK);
  const outputPricePerMtok = parsePrice(process.env.COST_OUTPUT_PRICE_PER_MTOK);
  const cachePricePerMtok = parsePrice(process.env.COST_CACHE_PRICE_PER_MTOK);

  const startTime = Date.now();
  try {
    const whereParts = [sql`nm.usage IS NOT NULL`];
    if (from) whereParts.push(sql`nm.raw_timestamp >= ${from}::date`);
    if (to) whereParts.push(sql`nm.raw_timestamp < (${to}::date + INTERVAL '1 day')`);
    const whereClause = sql.join(whereParts, sql` AND `);

    const inputTokensExpr = sql`
      CASE
        WHEN COALESCE(nm.usage->>'inputTokens', '') ~ '^[0-9]+([.][0-9]+)?$'
        THEN (nm.usage->>'inputTokens')::numeric
        ELSE 0
      END
    `;
    const outputTokensExpr = sql`
      CASE
        WHEN COALESCE(nm.usage->>'outputTokens', '') ~ '^[0-9]+([.][0-9]+)?$'
        THEN (nm.usage->>'outputTokens')::numeric
        ELSE 0
      END
    `;
    const cacheCreateTokensExpr = sql`
      CASE
        WHEN COALESCE(nm.usage->>'cacheCreationInputTokens', '') ~ '^[0-9]+([.][0-9]+)?$'
        THEN (nm.usage->>'cacheCreationInputTokens')::numeric
        ELSE 0
      END
    `;
    const cacheReadTokensExpr = sql`
      CASE
        WHEN COALESCE(nm.usage->>'cacheReadInputTokens', '') ~ '^[0-9]+([.][0-9]+)?$'
        THEN (nm.usage->>'cacheReadInputTokens')::numeric
        ELSE 0
      END
    `;

    const result = await db.execute(sql`
      WITH recalculated AS (
        SELECT
          nm.id,
          (
            (${inputTokensExpr}) / 1000000 * ${inputPricePerMtok} +
            (${outputTokensExpr}) / 1000000 * ${outputPricePerMtok} +
            (
              (${cacheCreateTokensExpr}) +
              (${cacheReadTokensExpr})
            ) / 1000000 * ${cachePricePerMtok}
          )::numeric(12,6) AS cost
        FROM normalized_messages nm
        WHERE ${whereClause}
      )
      UPDATE normalized_messages nm
      SET cost_usd = COALESCE(recalculated.cost, 0)
      FROM recalculated
      WHERE nm.id = recalculated.id
        AND nm.cost_usd IS DISTINCT FROM COALESCE(recalculated.cost, 0)
    `);

    const duration = Date.now() - startTime;
    const updateResult = result as { rowCount?: number; count?: number; length?: number };
    const updatedRows = updateResult.rowCount ?? updateResult.count ?? updateResult.length ?? 0;
    logger.info({ from, to, durationMs: duration, updatedRows }, 'Cost recompute done');
    return NextResponse.json({
      success: true,
      durationMs: duration,
      from: from ?? null,
      to: to ?? null,
      prices: {
        inputPricePerMtok,
        outputPricePerMtok,
        cachePricePerMtok,
      },
      updatedRows,
    });
  } catch (error) {
    logger.error({ error }, 'Cost recompute failed');
    return NextResponse.json({ error: 'Recompute failed' }, { status: 500 });
  }
}
