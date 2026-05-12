import { NextResponse } from 'next/server';
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { normalizedMessages } from '@/lib/db/schema';
import { authenticateAgent, isAgentContext } from '@/lib/auth/agent-auth';
import { logger } from '@/lib/logger';
import { computeCostFor, type UsageJson } from '@/lib/cost/compute';

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
  sourcePayload: z.record(z.string(), z.unknown()).nullable().optional(),
});

const ingestPayloadSchema = z.array(messageSchema).min(1).max(200);

// POST /api/agent/ingest
export async function POST(request: Request) {
  const startTime = Date.now();

  try {
    const authResult = await authenticateAgent(request);
    if (!isAgentContext(authResult)) {
      return authResult;
    }
    const { machine } = authResult;

    let bodyText: string;
    const contentEncoding = request.headers.get('content-encoding');
    if (contentEncoding === 'gzip') {
      const buffer = await request.arrayBuffer();
      const { gunzipSync } = await import('zlib');
      bodyText = gunzipSync(Buffer.from(buffer)).toString('utf-8');
    } else {
      bodyText = await request.text();
    }

    let messages;
    try {
      const parsed = JSON.parse(bodyText);
      messages = ingestPayloadSchema.parse(parsed);
    } catch (error) {
      if (error instanceof z.ZodError) {
        const issueSummary = error.issues
          .slice(0, 5)
          .map((i) => `${i.path.join('.')}: ${i.code}`);
        logger.warn(
          { machineId: machine.id, issueCount: error.issues.length, issues: issueSummary },
          'Ingest payload validation failed',
        );
        return NextResponse.json({ error: 'Payload invalid format' }, { status: 400 });
      }
      logger.warn({ machineId: machine.id }, 'Ingest payload JSON parse failure');
      return NextResponse.json({ error: 'JSON parse failure' }, { status: 400 });
    }

    logger.debug(
      { machineId: machine.id, messageCount: messages.length, bodySize: bodyText.length },
      'Ingest received batch',
    );

    let accepted = 0;
    const batchSize = 50;
    for (let i = 0; i < messages.length; i += batchSize) {
      const batch = messages.slice(i, i + batchSize);
      const values = batch.map((m) => {
        const ts = new Date(m.timestamp);
        const { costUsd } = computeCostFor(
          (m.usage ?? null) as UsageJson | null,
          ts,
          [],
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
          rawTimestamp: ts,
          metadata: m.metadata ?? {},
          sourcePayload: m.sourcePayload ?? null,
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
              rawTimestamp: sql`excluded.raw_timestamp`,
              metadata: sql`excluded.metadata`,
              sourcePayload: sql`excluded.source_payload`,
            },
          });
        accepted += batch.length;
      } catch (dbError) {
        // Batch failed — log and skip; do not fall back to per-row inserts.
        // Per-row fallback previously caused O(N) sequential round-trips during
        // first-sync bursts and could stall the process for minutes.
        logger.warn(
          {
            machineId: machine.id,
            batchIndex: i,
            batchSize: batch.length,
            err: (dbError as Error)?.message ?? String(dbError),
          },
          'Ingest batch write failed, skipping batch',
        );
      }
    }

    const duration = Date.now() - startTime;
    logger.info(
      { machineId: machine.id, messageCount: messages.length, accepted, durationMs: duration },
      'Ingest batch complete',
    );

    return NextResponse.json({ accepted });
  } catch (error) {
    logger.error({ err: (error as Error)?.message ?? String(error) }, 'Ingest handler exception');
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
