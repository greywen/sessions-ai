import { NextResponse } from 'next/server';
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { normalizedMessages, rawEvents } from '@/lib/db/schema';
import { authenticateAgent, isAgentContext } from '@/lib/auth/agent-auth';
import { logger } from '@/lib/logger';
import { createHash } from 'crypto';
import { computeCostFor, loadPricingForBatch, type UsageJson } from '@/lib/cost/compute';

// MESSAGE payload schema
const contentBlockSchema = z.object({
  blockType: z.string(),
  content: z.string(),
  language: z.string().nullable().optional(),
  filePath: z.string().nullable().optional(),
  diff: z.string().nullable().optional(),
  toolName: z.string().nullable().optional(),
  toolInput: z.record(z.string(), z.unknown()).nullable().optional(),
  exitCode: z.number().nullable().optional(),
  isCollapsed: z.boolean().optional(),
});

const tokenUsageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheCreationInputTokens: z.number().nullable().optional(),
  cacheReadInputTokens: z.number().nullable().optional(),
  model: z.string(),
});

const messageSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  parentId: z.string().nullable().optional(),
  machineId: z.string(),
  sourceTool: z.string(),
  role: z.string(),
  contentBlocks: z.array(contentBlockSchema),
  usage: tokenUsageSchema.nullable().optional(),
  timestamp: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const ingestPayloadSchema = z.array(messageSchema).min(1).max(200);

// POST /api/agent/ingest — Batch Data Acquisition
export async function POST(request: Request) {
  const startTime = Date.now();

  try {
    // 1. Agent Authentication
    const authResult = await authenticateAgent(request);
    if (!isAgentContext(authResult)) {
      return authResult; // Return error response
    }
    const { machine } = authResult;

    // 2. Unzip body(reqwest May be used when sending gzip)
    let bodyText: string;
    const contentEncoding = request.headers.get('content-encoding');
    if (contentEncoding === 'gzip') {
      const buffer = await request.arrayBuffer();
      // Inside Node.js Used in the environment zlib Unzip
      const { gunzipSync } = await import('zlib');
      bodyText = gunzipSync(Buffer.from(buffer)).toString('utf-8');
    } else {
      bodyText = await request.text();
    }

    // 3. Parse and Verify payload
    let messages;
    try {
      const parsed = JSON.parse(bodyText);
      messages = ingestPayloadSchema.parse(parsed);
    } catch (error) {
      if (error instanceof z.ZodError) {
        // Log only the issue paths/codes — `error.issues` includes the
        // received values (full message bodies) which are huge during sync.
        const issueSummary = error.issues
          .slice(0, 5)
          .map((i) => `${i.path.join('.')}: ${i.code}`);
        logger.warn(
          { machineId: machine.id, issueCount: error.issues.length, issues: issueSummary },
          'Ingest payload Verification failed',
        );
        return NextResponse.json(
          { error: 'Payload Invalid format' },
          { status: 400 },
        );
      }
      logger.warn({ machineId: machine.id }, 'Ingest payload JSON Parse Failure');
      return NextResponse.json({ error: 'JSON Parse Failure' }, { status: 400 });
    }

    logger.debug(
      {
        machineId: machine.id,
        messageCount: messages.length,
        bodySize: bodyText.length,
      },
      'Ingest Received batch escalation',
    );

    // 4. Bulk insert normalized_messages.
    // The same message id may be reported multiple times due to CRDT streaming
    // completion; use ON CONFLICT for idempotent updates.
    //
    // Pricing materialization: for each batch we load all pricing rows that
    // could possibly match any of the batch's models in one query, then
    // compute `cost_usd` + `pricing_id` per message in TS (see
    // lib/cost/compute.ts). Reads no longer need to JOIN pricing_table.
    let accepted = 0;
    const batchSize = 50;
    for (let i = 0; i < messages.length; i += batchSize) {
      const batch = messages.slice(i, i + batchSize);
      const pricings = await loadPricingForBatch(
        db,
        batch.map((m) => ({ usage: (m.usage ?? null) as UsageJson | null })),
      );
      const values = batch.map((m) => {
        const ts = new Date(m.timestamp);
        const { costUsd, pricingId } = computeCostFor(
          (m.usage ?? null) as UsageJson | null,
          ts,
          pricings,
        );
        return {
          id: m.id,
          sessionId: m.sessionId,
          parentId: m.parentId ?? null,
          machineId: machine.id,
          sourceTool: m.sourceTool,
          role: m.role,
          contentBlocks: m.contentBlocks,
          usage: m.usage ?? null,
          costUsd,
          pricingId,
          rawTimestamp: ts,
          metadata: m.metadata ?? {},
        };
      });

      try {
        await db
          .insert(normalizedMessages)
          .values(values)
          .onConflictDoUpdate({
            target: normalizedMessages.id,
            set: {
              sessionId: sql`excluded.session_id`,
              parentId: sql`excluded.parent_id`,
              sourceTool: sql`excluded.source_tool`,
              role: sql`excluded.role`,
              contentBlocks: sql`excluded.content_blocks`,
              usage: sql`excluded.usage`,
              costUsd: sql`excluded.cost_usd`,
              pricingId: sql`excluded.pricing_id`,
              rawTimestamp: sql`excluded.raw_timestamp`,
              metadata: sql`excluded.metadata`,
            },
          });
        accepted += batch.length;
      } catch (dbError) {
        // Drizzle/pg errors stringify the full SQL + parameter values, which
        // includes every message's content_blocks JSON. Only keep the message.
        logger.warn(
          { machineId: machine.id, batchIndex: i, batchSize: batch.length, err: (dbError as Error)?.message ?? String(dbError) },
          'Ingest 批量写入失败,回退到逐条',
        );
        for (const value of values) {
          try {
            await db
              .insert(normalizedMessages)
              .values(value)
              .onConflictDoUpdate({
                target: normalizedMessages.id,
                set: {
                  sessionId: sql`excluded.session_id`,
                  parentId: sql`excluded.parent_id`,
                  sourceTool: sql`excluded.source_tool`,
                  role: sql`excluded.role`,
                  contentBlocks: sql`excluded.content_blocks`,
                  usage: sql`excluded.usage`,
                  costUsd: sql`excluded.cost_usd`,
                  pricingId: sql`excluded.pricing_id`,
                  rawTimestamp: sql`excluded.raw_timestamp`,
                  metadata: sql`excluded.metadata`,
                },
              });
            accepted += 1;
          } catch {
            // Skip individual failed rows.
          }
        }
      }
    }

    // 5. Simultaneous writes raw_events(Raw Data Backup)
    const contentHash = createHash('sha256').update(bodyText).digest('hex');
    const sourceTool = messages[0]?.sourceTool ?? 'unknown';
    try {
      await db
        .insert(rawEvents)
        .values({
          machineId: machine.id,
          sourceTool,
          sourceFilePath: `ingest/${new Date().toISOString().split('T')[0]}`,
          rawContent: Buffer.from(bodyText).toString('base64'),
          contentHash,
        })
        .onConflictDoNothing();
    } catch (rawError) {
      // raw_events Write failure does not affect the mainstream
      logger.warn({ machineId: machine.id, err: (rawError as Error)?.message ?? String(rawError) }, 'raw_events failure on writing');
    }

    const duration = Date.now() - startTime;
    logger.info(
      {
        machineId: machine.id,
        messageCount: messages.length,
        accepted,
        durationMs: duration,
      },
      'Ingest Batch Escalation Complete',
    );

    return NextResponse.json({ accepted });
  } catch (error) {
    logger.error({ err: (error as Error)?.message ?? String(error) }, 'Ingest Handling Exceptions');
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
