import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { configPushLogs, machines } from '@/lib/db/schema';
import { logger } from '@/lib/logger';
import { eq, and } from 'drizzle-orm';

const ackSchema = z.union([
  z.object({
    pushLogId: z.string().uuid(),
    status: z.enum(['acked', 'failed']),
    errorMessage: z.string().nullable().optional(),
  }),
  z.object({
    pushLogId: z.string().uuid(),
    success: z.boolean(),
    errorMessage: z.string().nullable().optional(),
  }),
]);

// POST /api/agent/config/ack — Agent Confirm Configuration Applied
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
    const parsed = ackSchema.safeParse(body);
    if (!parsed.success) {
      logger.warn(
        { machineId: machine.id, issues: parsed.error.issues, body },
        'Agent Configure ACK Logic check failed.',
      );
      return NextResponse.json({ error: 'Logic check failed.', details: parsed.error.issues }, { status: 400 });
    }

    const data = parsed.data;
    const status = 'status' in data ? data.status : (data.success ? 'acked' : 'failed');

    // Update push record status
    const [updated] = await db
      .update(configPushLogs)
      .set({
        status,
        ackedAt: new Date(),
        errorMessage: data.errorMessage ?? null,
      })
      .where(
        and(
          eq(configPushLogs.id, data.pushLogId),
          eq(configPushLogs.machineId, machine.id),
        ),
      )
      .returning();

    if (!updated) {
      return NextResponse.json({ error: 'Push record does not exist' }, { status: 404 });
    }

    logger.info(
      { pushLogId: data.pushLogId, machineId: machine.id, status },
      'Agent Configure ACK Receive',
    );

    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error({ error }, 'Agent Configure ACK Abnormal');
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
