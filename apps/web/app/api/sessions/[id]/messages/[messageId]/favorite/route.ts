import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { normalizedMessages, favoriteSnapshots } from '@/lib/db/schema';
import { getSession } from '@/lib/auth/session';
import { logger } from '@/lib/logger';
import { and, eq } from 'drizzle-orm';

const paramsSchema = z.object({
  id: z.string().min(1),
  messageId: z.string().uuid(),
});

const patchSchema = z.object({
  favorite: z.boolean(),
  // Optional user note attached at favorite-time. Only persisted when
  // favorite=true.
  note: z.string().max(2000).optional(),
});

// PATCH /api/sessions/[id]/messages/[messageId]/favorite
//
// favorite=true  → take a deep snapshot of the message and write it to
//                  `favorite_snapshots`. The snapshot survives parser
//                  rewrites and even deletion of the source row.
// favorite=false → delete the snapshot for (user, source_message_id).
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; messageId: string }> },
) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: 'not_logged_in' }, { status: 401 });
    }

    const resolvedParams = paramsSchema.parse(await params);
    const body = await request.json();
    const data = patchSchema.parse(body);

    if (!data.favorite) {
      await db
        .delete(favoriteSnapshots)
        .where(
          and(
            eq(favoriteSnapshots.userId, session.userId),
            eq(favoriteSnapshots.sourceMessageId, resolvedParams.messageId),
          ),
        );
      return NextResponse.json({
        data: { messageId: resolvedParams.messageId, isFavorite: false },
      });
    }

    // Pull the full message row so we can freeze a complete copy.
    const [src] = await db
      .select({
        id: normalizedMessages.id,
        sessionId: normalizedMessages.sessionId,
        sourceTool: normalizedMessages.sourceTool,
        machineId: normalizedMessages.machineId,
        role: normalizedMessages.role,
        contentBlocks: normalizedMessages.contentBlocks,
        usage: normalizedMessages.usage,
        metadata: normalizedMessages.metadata,
        sourcePayload: normalizedMessages.sourcePayload,
        rawTimestamp: normalizedMessages.rawTimestamp,
      })
      .from(normalizedMessages)
      .where(
        and(
          eq(normalizedMessages.id, resolvedParams.messageId),
          eq(normalizedMessages.sessionId, resolvedParams.id),
        ),
      )
      .limit(1);

    if (!src) {
      return NextResponse.json({ error: 'Message does not exist' }, { status: 404 });
    }

    await db
      .insert(favoriteSnapshots)
      .values({
        userId: session.userId,
        sourceMessageId: src.id,
        sourceSessionId: src.sessionId,
        sourceTool: src.sourceTool,
        machineId: src.machineId,
        role: src.role,
        contentBlocks: src.contentBlocks ?? [],
        usage: src.usage ?? null,
        metadata: src.metadata ?? null,
        sourcePayload: src.sourcePayload ?? null,
        rawTimestamp: src.rawTimestamp,
        userNote: data.note ?? null,
      })
      .onConflictDoUpdate({
        target: [favoriteSnapshots.userId, favoriteSnapshots.sourceMessageId],
        // Re-favoriting refreshes the snapshot to the current state of the
        // source message and updates the optional note when supplied.
        set: {
          contentBlocks: src.contentBlocks ?? [],
          usage: src.usage ?? null,
          metadata: src.metadata ?? null,
          sourcePayload: src.sourcePayload ?? null,
          rawTimestamp: src.rawTimestamp,
          userNote: data.note ?? null,
          snapshottedAt: new Date(),
        },
      });

    return NextResponse.json({
      data: { messageId: resolvedParams.messageId, isFavorite: true },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Request param is invalid', details: error.issues },
        { status: 400 },
      );
    }
    logger.error({ error }, 'Message favorite update exception');
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
