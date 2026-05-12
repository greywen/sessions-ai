import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { favoriteSnapshots } from '@/lib/db/schema';
import { getSession } from '@/lib/auth/session';
import { logger } from '@/lib/logger';
import { and, desc, eq, lt } from 'drizzle-orm';

const querySchema = z.object({
  // Reverse cursor: snapshots older than this snapshottedAt
  before: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  sourceTool: z.string().optional(),
  sessionId: z.string().optional(),
});

// GET /api/favorites/messages
//
// Lists the current user's frozen message favorites across ALL sessions.
// This view is sourced ONLY from `favorite_snapshots`, so it stays correct
// even when the original `normalized_messages` rows have been re-parsed or
// purged. That's the point of snapshotting in the first place.
export async function GET(request: Request) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: 'not_logged_in' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const params = querySchema.parse({
      before: searchParams.get('before') ?? undefined,
      limit: searchParams.get('limit') ?? undefined,
      sourceTool: searchParams.get('sourceTool') ?? undefined,
      sessionId: searchParams.get('sessionId') ?? undefined,
    });

    const conditions = [eq(favoriteSnapshots.userId, session.userId)];
    if (params.before) {
      conditions.push(lt(favoriteSnapshots.snapshottedAt, new Date(params.before)));
    }
    if (params.sourceTool) {
      conditions.push(eq(favoriteSnapshots.sourceTool, params.sourceTool));
    }
    if (params.sessionId) {
      conditions.push(eq(favoriteSnapshots.sourceSessionId, params.sessionId));
    }

    const rows = await db
      .select({
        id: favoriteSnapshots.id,
        sourceMessageId: favoriteSnapshots.sourceMessageId,
        sourceSessionId: favoriteSnapshots.sourceSessionId,
        sourceTool: favoriteSnapshots.sourceTool,
        machineId: favoriteSnapshots.machineId,
        role: favoriteSnapshots.role,
        contentBlocks: favoriteSnapshots.contentBlocks,
        usage: favoriteSnapshots.usage,
        metadata: favoriteSnapshots.metadata,
        sourcePayload: favoriteSnapshots.sourcePayload,
        rawTimestamp: favoriteSnapshots.rawTimestamp,
        userNote: favoriteSnapshots.userNote,
        snapshottedAt: favoriteSnapshots.snapshottedAt,
      })
      .from(favoriteSnapshots)
      .where(and(...conditions))
      .orderBy(desc(favoriteSnapshots.snapshottedAt))
      .limit(params.limit + 1);

    const hasMore = rows.length > params.limit;
    const data = hasMore ? rows.slice(0, -1) : rows;
    const last = data[data.length - 1];
    const nextCursor = hasMore && last ? last.snapshottedAt.toISOString() : null;

    return NextResponse.json({ data, nextCursor });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Invalid query parameters', details: error.issues },
        { status: 400 },
      );
    }
    logger.error({ error }, 'Favorite snapshot list query exception');
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
