import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { normalizedMessages, favoriteSnapshots } from '@/lib/db/schema';
import { getSession } from '@/lib/auth/session';
import { logger } from '@/lib/logger';
import { and, asc, desc, eq, gt, lt, sql } from 'drizzle-orm';

const COMPACT_PREVIEW_MAX_LENGTH = 360;

function extractPreviewText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map((item) => extractPreviewText(item)).filter(Boolean).join(' ').trim();
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const candidates = [obj.content, obj.text, obj.value, obj.message];
    for (const candidate of candidates) {
      const text = extractPreviewText(candidate);
      if (text) return text;
    }
  }
  return '';
}

function toCompactPreview(contentBlocks: unknown): string {
  if (!Array.isArray(contentBlocks) || contentBlocks.length === 0) return '';
  const text = contentBlocks
    .map((block) => extractPreviewText(block))
    .filter(Boolean)
    .join('\n')
    .trim();
  if (!text) return '';
  return text.length > COMPACT_PREVIEW_MAX_LENGTH
    ? `${text.slice(0, COMPACT_PREVIEW_MAX_LENGTH)}...`
    : text;
}

const querySchema = z.object({
  cursor: z.string().datetime().optional(),
  // before= fetches messages *older than* this timestamp (reverse pagination)
  before: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  // desc = newest-first (used for initial load / before= pages), asc = oldest-first (legacy)
  order: z.enum(['asc', 'desc']).default('asc'),
  favorite: z.enum(['true', 'false']).optional(),
  compact: z.enum(['true', 'false']).optional(),
  lite: z.enum(['true', 'false']).optional(),
});

// GET /api/sessions/[id]/messages
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: 'not_logged_in' }, { status: 401 });
    }

    const { id: sessionId } = await params;
    const { searchParams } = new URL(request.url);

    const queryParams = querySchema.parse({
      cursor: searchParams.get('cursor') ?? undefined,
      before: searchParams.get('before') ?? undefined,
      limit: searchParams.get('limit') ?? undefined,
      order: searchParams.get('order') ?? undefined,
      favorite: searchParams.get('favorite') ?? undefined,
      compact: searchParams.get('compact') ?? undefined,
      lite: searchParams.get('lite') ?? undefined,
    });

    const startTime = Date.now();
    const isDesc = queryParams.order === 'desc';

    const conditions = [eq(normalizedMessages.sessionId, sessionId)];

    // forward cursor (asc mode): messages after this timestamp
    if (queryParams.cursor) {
      conditions.push(gt(normalizedMessages.rawTimestamp, new Date(queryParams.cursor)));
    }

    // reverse cursor (desc mode / before= ): messages older than this timestamp
    if (queryParams.before) {
      conditions.push(lt(normalizedMessages.rawTimestamp, new Date(queryParams.before)));
    }

    if (queryParams.compact !== 'true' && queryParams.lite !== 'true' && queryParams.favorite === 'true') {
      conditions.push(sql`${favoriteSnapshots.id} IS NOT NULL`);
    }
    if (queryParams.compact !== 'true' && queryParams.lite !== 'true' && queryParams.favorite === 'false') {
      conditions.push(sql`${favoriteSnapshots.id} IS NULL`);
    }

    const orderBy = isDesc
      ? desc(normalizedMessages.rawTimestamp)
      : asc(normalizedMessages.rawTimestamp);

    if (queryParams.compact === 'true') {
      const rows = await db
        .select({
          id: normalizedMessages.id,
          role: normalizedMessages.role,
          contentBlocks: normalizedMessages.contentBlocks,
          rawTimestamp: normalizedMessages.rawTimestamp,
        })
        .from(normalizedMessages)
        .where(and(...conditions))
        .orderBy(orderBy)
        .limit(queryParams.limit + 1);

      const queryDuration = Date.now() - startTime;
      if (queryDuration > 500) {
        logger.warn({ sessionId, durationMs: queryDuration }, 'Message list query slow');
      }

      const hasMore = rows.length > queryParams.limit;
      const pageRows = hasMore ? rows.slice(0, -1) : rows;
      const data = pageRows.map((row) => ({
        id: row.id,
        role: row.role,
        preview: toCompactPreview(row.contentBlocks),
        rawTimestamp: row.rawTimestamp,
      }));
      const lastRow = pageRows[pageRows.length - 1];
      const nextCursor = hasMore && lastRow
        ? lastRow.rawTimestamp?.toISOString() ?? null
        : null;

      return NextResponse.json({ data, nextCursor });
    }

    if (queryParams.lite === 'true') {
      const rows = await db
        .select({
          id: normalizedMessages.id,
          sourceTool: normalizedMessages.sourceTool,
          role: normalizedMessages.role,
          contentBlocks: normalizedMessages.contentBlocks,
          usage: normalizedMessages.usage,
          rawTimestamp: normalizedMessages.rawTimestamp,
        })
        .from(normalizedMessages)
        .where(and(...conditions))
        .orderBy(orderBy)
        .limit(queryParams.limit + 1);

      const queryDuration = Date.now() - startTime;
      if (queryDuration > 500) {
        logger.warn({ sessionId, durationMs: queryDuration }, 'Message list query slow');
      }

      const hasMore = rows.length > queryParams.limit;
      const data = hasMore ? rows.slice(0, -1) : rows;
      const lastRow = data[data.length - 1];
      const nextCursor = hasMore && lastRow ? lastRow.rawTimestamp?.toISOString() ?? null : null;

      return NextResponse.json({ data, nextCursor });
    }

    const rows = await db
      .select({
        id: normalizedMessages.id,
        sessionId: normalizedMessages.sessionId,
        parentId: normalizedMessages.parentId,
        machineId: normalizedMessages.machineId,
        sourceTool: normalizedMessages.sourceTool,
        role: normalizedMessages.role,
        contentBlocks: normalizedMessages.contentBlocks,
        usage: normalizedMessages.usage,
        rawTimestamp: normalizedMessages.rawTimestamp,
        metadata: normalizedMessages.metadata,
        createdAt: normalizedMessages.createdAt,
        isFavorite: sql<boolean>`${favoriteSnapshots.id} IS NOT NULL`.as('is_favorite'),
      })
      .from(normalizedMessages)
      .leftJoin(
        favoriteSnapshots,
        and(
          eq(favoriteSnapshots.sourceMessageId, normalizedMessages.id),
          eq(favoriteSnapshots.userId, session.userId),
        ),
      )
      .where(and(...conditions))
      .orderBy(orderBy)
      .limit(queryParams.limit + 1);

    const queryDuration = Date.now() - startTime;
    if (queryDuration > 500) {
      logger.warn({ sessionId, durationMs: queryDuration }, 'Message list query slow');
    }

    const hasMore = rows.length > queryParams.limit;
    const data = hasMore ? rows.slice(0, -1) : rows;
    const lastRow = data[data.length - 1];
    const nextCursor = hasMore && lastRow ? lastRow.rawTimestamp?.toISOString() ?? null : null;

    logger.debug(
      { sessionId, resultCount: data.length, hasMore, durationMs: queryDuration, order: queryParams.order },
      'Message list query complete',
    );

    return NextResponse.json({ data, nextCursor });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Invalid query parameters', details: error.issues },
        { status: 400 },
      );
    }
    logger.error({ error }, 'Message list query exception');
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
