import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { normalizedMessages, machines, users, sessionFavorites } from '@/lib/db/schema';
import { getSession } from '@/lib/auth/session';
import { logger } from '@/lib/logger';
import { eq, count, min, max, sql, and } from 'drizzle-orm';

const patchSchema = z.object({
  favorite: z.boolean(),
});

// GET /api/sessions/[id] — Session Details Metadata(Contains device and user information,Token Statistics)
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

    // Get session metadata
    const [metadata] = await db
      .select({
        sessionId: normalizedMessages.sessionId,
        sourceTool: normalizedMessages.sourceTool,
        machineId: normalizedMessages.machineId,
        messageCount: count(normalizedMessages.id).as('message_count'),
        firstMessageAt: min(normalizedMessages.rawTimestamp).as('first_message_at'),
        lastMessageAt: max(normalizedMessages.rawTimestamp).as('last_message_at'),
      })
      .from(normalizedMessages)
      .where(eq(normalizedMessages.sessionId, sessionId))
      .groupBy(
        normalizedMessages.sessionId,
        normalizedMessages.sourceTool,
        normalizedMessages.machineId,
      );

    if (!metadata) {
      return NextResponse.json({ error: 'Session does not exist' }, { status: 404 });
    }

    // Get device and user information
    const [machineInfo] = await db
      .select({
        displayName: machines.displayName,
        ownerName: users.name,
        ownerEmail: users.email,
      })
      .from(machines)
      .leftJoin(users, eq(machines.ownerId, users.id))
      .where(eq(machines.id, metadata.machineId));

    // Dapatkan Token Use Aggregation
    const [tokenStats] = await db.execute(sql`
      SELECT
        COALESCE(SUM((usage->>'inputTokens')::bigint), 0) as total_input_tokens,
        COALESCE(SUM((usage->>'outputTokens')::bigint), 0) as total_output_tokens,
        COALESCE(SUM((usage->>'cacheReadInputTokens')::bigint), 0) as total_cache_tokens
      FROM normalized_messages
      WHERE session_id = ${sessionId}
        AND usage IS NOT NULL
    `);
    const [favoriteRow] = await db
      .select({ id: sessionFavorites.id })
      .from(sessionFavorites)
      .where(
        and(
          eq(sessionFavorites.userId, session.userId),
          eq(sessionFavorites.sessionId, sessionId),
        ),
      )
      .limit(1);

    // Extract session title from the first message metadata containing sessionTitle.
    const [titleRow] = await db.execute(sql`
      SELECT metadata->>'sessionTitle' AS session_title
      FROM normalized_messages
      WHERE session_id = ${sessionId}
        AND metadata ? 'sessionTitle'
      ORDER BY raw_timestamp ASC
      LIMIT 1
    `);
    const sessionTitle =
      titleRow && typeof titleRow.session_title === 'string' && titleRow.session_title.length > 0
        ? titleRow.session_title
        : null;

    logger.debug(
      { sessionId, messageCount: metadata.messageCount },
      'Query session details',
    );

    return NextResponse.json({
      data: {
        ...metadata,
        sessionTitle,
        isFavorite: !!favoriteRow,
        deviceName: machineInfo?.displayName ?? null,
        ownerName: machineInfo?.ownerName ?? null,
        ownerEmail: machineInfo?.ownerEmail ?? null,
        totalInputTokens: Number(tokenStats?.total_input_tokens ?? 0),
        totalOutputTokens: Number(tokenStats?.total_output_tokens ?? 0),
        totalCacheTokens: Number(tokenStats?.total_cache_tokens ?? 0),
      },
    });
  } catch (error) {
    logger.error({ error }, 'Session details query exception');
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

// PATCH /api/sessions/[id] — Set favorite status for a session
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: 'not_logged_in' }, { status: 401 });
    }

    const { id: sessionId } = await params;
    const body = await request.json();
    const data = patchSchema.parse(body);

    const [existingSession] = await db
      .select({ id: normalizedMessages.id })
      .from(normalizedMessages)
      .where(eq(normalizedMessages.sessionId, sessionId))
      .limit(1);

    if (!existingSession) {
      return NextResponse.json({ error: 'Session does not exist' }, { status: 404 });
    }

    if (data.favorite) {
      await db
        .insert(sessionFavorites)
        .values({
          userId: session.userId,
          sessionId,
        })
        .onConflictDoNothing({
          target: [sessionFavorites.userId, sessionFavorites.sessionId],
        });
    } else {
      await db
        .delete(sessionFavorites)
        .where(
          and(
            eq(sessionFavorites.userId, session.userId),
            eq(sessionFavorites.sessionId, sessionId),
          ),
        );
    }

    return NextResponse.json({
      data: {
        sessionId,
        isFavorite: data.favorite,
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Request param is invalid', details: error.issues },
        { status: 400 },
      );
    }
    logger.error({ error }, 'Session favorite update exception');
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
