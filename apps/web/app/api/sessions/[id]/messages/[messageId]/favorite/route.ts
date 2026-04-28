import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { normalizedMessages, messageFavorites } from '@/lib/db/schema';
import { getSession } from '@/lib/auth/session';
import { logger } from '@/lib/logger';
import { and, eq } from 'drizzle-orm';

const paramsSchema = z.object({
  id: z.string().min(1),
  messageId: z.string().uuid(),
});

const patchSchema = z.object({
  favorite: z.boolean(),
});

// PATCH /api/sessions/[id]/messages/[messageId]/favorite — Set favorite status for one message
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

    const [existingMessage] = await db
      .select({ id: normalizedMessages.id })
      .from(normalizedMessages)
      .where(
        and(
          eq(normalizedMessages.id, resolvedParams.messageId),
          eq(normalizedMessages.sessionId, resolvedParams.id),
        ),
      )
      .limit(1);

    if (!existingMessage) {
      return NextResponse.json({ error: 'Message does not exist' }, { status: 404 });
    }

    if (data.favorite) {
      await db
        .insert(messageFavorites)
        .values({
          userId: session.userId,
          messageId: resolvedParams.messageId,
        })
        .onConflictDoNothing({
          target: [messageFavorites.userId, messageFavorites.messageId],
        });
    } else {
      await db
        .delete(messageFavorites)
        .where(
          and(
            eq(messageFavorites.userId, session.userId),
            eq(messageFavorites.messageId, resolvedParams.messageId),
          ),
        );
    }

    return NextResponse.json({
      data: {
        messageId: resolvedParams.messageId,
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
    logger.error({ error }, 'Message favorite update exception');
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
