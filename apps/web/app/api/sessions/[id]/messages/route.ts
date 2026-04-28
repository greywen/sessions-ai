import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { normalizedMessages } from '@/lib/db/schema';
import { getSession } from '@/lib/auth/session';
import { logger } from '@/lib/logger';
import { eq, gt, asc } from 'drizzle-orm';

// Query Parameter Verification
const querySchema = z.object({
  cursor: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
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
    });

    // Cursor-based Pagination Query
    const conditions = [eq(normalizedMessages.sessionId, sessionId)];
    if (queryParams.cursor) {
      conditions.push(
        gt(normalizedMessages.rawTimestamp, new Date(queryParams.cursor)),
      );
    }

    const startTime = Date.now();

    // Take an extra one to determine if there is a next page
    const messages = await db.query.normalizedMessages.findMany({
      where: (table, { and, eq: eqOp, gt: gtOp }) => {
        const conds = [eqOp(table.sessionId, sessionId)];
        if (queryParams.cursor) {
          conds.push(gtOp(table.rawTimestamp, new Date(queryParams.cursor)));
        }
        return and(...conds);
      },
      orderBy: (table, { asc: ascOp }) => [ascOp(table.rawTimestamp)],
      limit: queryParams.limit + 1,
    });

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
