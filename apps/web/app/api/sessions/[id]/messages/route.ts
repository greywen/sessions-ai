import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { normalizedMessages, messageFavorites } from '@/lib/db/schema';
import { getSession } from '@/lib/auth/session';
import { logger } from '@/lib/logger';
import { and, asc, eq, gt, sql } from 'drizzle-orm';

// Query Parameter Verification
const querySchema = z.object({
  cursor: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  favorite: z.enum(['true', 'false']).optional(),
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
    });

    const startTime = Date.now();

    // Take an extra one to determine if there is a next page
    const conditions = [eq(normalizedMessages.sessionId, sessionId)];
    if (queryParams.cursor) {
      conditions.push(gt(normalizedMessages.rawTimestamp, new Date(queryParams.cursor)));
    }
    if (queryParams.favorite === 'true') {
      conditions.push(sql`${messageFavorites.id} IS NOT NULL`);
    }
    if (queryParams.favorite === 'false') {
      conditions.push(sql`${messageFavorites.id} IS NULL`);
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
