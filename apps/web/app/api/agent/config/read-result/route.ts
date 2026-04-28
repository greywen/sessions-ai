import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { configReadRequests, machines } from '@/lib/db/schema';
import { logger } from '@/lib/logger';
import { eq, and } from 'drizzle-orm';

const readResultSchema = z.object({
  requestId: z.string().uuid(),
  content: z.unknown().nullable(),
  error: z.string().nullable().optional(),
});

// POST /api/agent/config/read-result — Agent Report Profile Read Result
export async function POST(request: Request) {
  try {
    const key = request.headers.get('authorization')?.replace('Bearer ', '');
    const fingerprint = request.headers.get('x-machine-fingerprint');

    if (!key || !fingerprint) {
      return NextResponse.json({ error: 'Not Authorised' }, { status: 401 });
    }

    const machine = await db.query.machines.findFirst({
      where: and(eq(machines.authKey, key), eq(machines.status, 'active')),
    });

    if (!machine) {
      return NextResponse.json({ error: 'Device not authorized' }, { status: 403 });
    }

    if (machine.fingerprint !== fingerprint) {
      return NextResponse.json({ error: 'Fingerprint mismatch' }, { status: 403 });
    }

    const body = await request.json();
    const data = readResultSchema.parse(body);

    const hasError = !!data.error;
    const [updated] = await db
      .update(configReadRequests)
      .set({
        status: hasError ? 'failed' : 'completed',
        content: data.content ?? null,
        error: data.error ?? null,
        completedAt: new Date(),
      })
      .where(
        and(
          eq(configReadRequests.id, data.requestId),
          eq(configReadRequests.machineId, machine.id),
        ),
      )
      .returning();

    if (!updated) {
      return NextResponse.json({ error: 'Read request does not exist' }, { status: 404 });
    }

    logger.info(
      { requestId: data.requestId, machineId: machine.id, status: hasError ? 'failed' : 'completed' },
      'Agent Profile Read Result Return',
    );

    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Logic check failed.', details: error.issues }, { status: 400 });
    }
    logger.error({ error }, 'Agent Configuration Read Result Report Exception');
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
