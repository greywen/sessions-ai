import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { normalizedMessages, messageFavorites } from '@/lib/db/schema';
import { getSession } from '@/lib/auth/session';
import { logger } from '@/lib/logger';
import { and, asc, eq, gt, sql } from 'drizzle-orm';

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

// Query Parameter Verification
const querySchema = z.object({
  cursor: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  favorite: z.enum(['true', 'false']).optional(),
  compact: z.enum(['true', 'false']).optional(),
  lite: z.enum(['true', 'false']).optional(),
});

// GET /api/sessions/[id]/messages — Pagination Loading Message(cursor-based)
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
      limit: searchParams.get('limit') ?? undefined,
      favorite: searchParams.get('favorite') ?? undefined,
      compact: searchParams.get('compact') ?? undefined,
      lite: searchParams.get('lite') ?? undefined,
    });

    const startTime = Date.now();

    // Take an extra one to determine if there is a next page
    const conditions = [eq(normalizedMessages.sessionId, sessionId)];
    if (queryParams.cursor) {
      conditions.push(gt(normalizedMessages.rawTimestamp, new Date(queryParams.cursor)));
    }
    if (queryParams.compact !== 'true' && queryParams.lite !== 'true' && queryParams.favorite === 'true') {
      conditions.push(sql`${messageFavorites.id} IS NOT NULL`);
    }
    if (queryParams.compact !== 'true' && queryParams.lite !== 'true' && queryParams.favorite === 'false') {
      conditions.push(sql`${messageFavorites.id} IS NULL`);
    }

    if (queryParams.compact === 'true') {
      const messages = await db
        .select({
          id: normalizedMessages.id,
          role: normalizedMessages.role,
          contentBlocks: normalizedMessages.contentBlocks,
          rawTimestamp: normalizedMessages.rawTimestamp,
        })
        .from(normalizedMessages)
        .where(and(...conditions))
        .orderBy(asc(normalizedMessages.rawTimestamp))
        .limit(queryParams.limit + 1);

      const queryDuration = Date.now() - startTime;
      if (queryDuration > 500) {
        logger.warn(
          { sessionId, durationMs: queryDuration },
          'Message List Query Timeout',
        );
      }

      const hasMore = messages.length > queryParams.limit;
      const pageRows = hasMore ? messages.slice(0, -1) : messages;
      const data = pageRows.map((row) => ({
        id: row.id,
        role: row.role,
        preview: toCompactPreview(row.contentBlocks),
        rawTimestamp: row.rawTimestamp,
      }));
      const nextCursor = hasMore
        ? pageRows[pageRows.length - 1]?.rawTimestamp?.toISOString() ?? null
        : null;

      logger.debug(
        {
          sessionId,
          resultCount: data.length,
          hasMore,
          durationMs: queryDuration,
          compact: true,
        },
        'Message List Query Complete',
      );

      return NextResponse.json({
        data,
        nextCursor,
      });
    }

    if (queryParams.lite === 'true') {
      const messages = await db
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
        .orderBy(asc(normalizedMessages.rawTimestamp))
        .limit(queryParams.limit + 1);

      const queryDuration = Date.now() - startTime;
      if (queryDuration > 500) {
        logger.warn(
          { sessionId, durationMs: queryDuration },
          'Message List Query Timeout',
        );
      }

      const hasMore = messages.length > queryParams.limit;
      const data = hasMore ? messages.slice(0, -1) : messages;
      const nextCursor = hasMore
        ? data[data.length - 1]?.rawTimestamp?.toISOString() ?? null
        : null;

      logger.debug(
        {
          sessionId,
          resultCount: data.length,
          hasMore,
          durationMs: queryDuration,
          compact: false,
          lite: true,
        },
        'Message List Query Complete',
      );

      return NextResponse.json({
        data,
        nextCursor,
      });
    }

    const messages = await db
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
        isFavorite: sql<boolean>`${messageFavorites.id} IS NOT NULL`.as('is_favorite'),
      })
      .from(normalizedMessages)
      .leftJoin(
        messageFavorites,
        and(
          eq(messageFavorites.messageId, normalizedMessages.id),
          eq(messageFavorites.userId, session.userId),
        ),
      )
      .where(and(...conditions))
      .orderBy(asc(normalizedMessages.rawTimestamp))
      .limit(queryParams.limit + 1);

    const queryDuration = Date.now() - startTime;
    if (queryDuration > 500) {
      logger.warn(
        { sessionId, durationMs: queryDuration },
        'Message List Query Timeout',
      );
    }

    const hasMore = messages.length > queryParams.limit;
    const data = hasMore ? messages.slice(0, -1) : messages;
    const nextCursor = hasMore
      ? data[data.length - 1]?.rawTimestamp?.toISOString() ?? null
      : null;

    logger.debug(
      {
        sessionId,
        resultCount: data.length,
        hasMore,
        durationMs: queryDuration,
        compact: false,
      },
      'Message List Query Complete',
    );

    return NextResponse.json({
      data,
      nextCursor,
    });
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
