import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { configReadRequests, machines } from '@/lib/db/schema';
import { getSession } from '@/lib/auth/session';
import { hasRole } from '@/lib/auth/roles';
import { logger } from '@/lib/logger';
import { eq, and } from 'drizzle-orm';

const createReadRequestSchema = z.object({
  filePath: z.string().min(1, 'File path cannot be empty'),
});

// POST /api/devices/[id]/config-read — Create profile read request
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: 'not_logged_in' }, { status: 401 });
    }
    if (!hasRole(session.role, 'admin')) {
      return NextResponse.json({ error: 'Insufficient Permissions' }, { status: 403 });
    }

    const { id: machineId } = await params;
    const body = await request.json();
    const data = createReadRequestSchema.parse(body);

    // Confirm the device exists and is online
    const machine = await db.query.machines.findFirst({
      where: eq(machines.id, machineId),
    });
    if (!machine) {
      return NextResponse.json({ error: 'Device does not exist, bailing.' }, { status: 404 });
    }
    if (machine.status !== 'active') {
      return NextResponse.json({ error: 'Device is not active' }, { status: 400 });
    }

    // Create Read Request
    const [req] = await db
      .insert(configReadRequests)
      .values({
        machineId,
        filePath: data.filePath,
        requestedBy: session.userId,
      })
      .returning();

    logger.info(
      { requestId: req.id, machineId, filePath: data.filePath },
      'Create profile read request',
    );

    return NextResponse.json({ data: { requestId: req.id } }, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Logic check failed.', details: error.issues }, { status: 400 });
    }
    logger.error({ error }, 'Create Configuration Read Request Exception');
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

// GET /api/devices/[id]/config-read?requestId=xxx — Poll Read Result
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: 'not_logged_in' }, { status: 401 });
    }
    if (!hasRole(session.role, 'admin')) {
      return NextResponse.json({ error: 'Insufficient Permissions' }, { status: 403 });
    }

    const { id: machineId } = await params;
    const { searchParams } = new URL(request.url);
    const requestId = searchParams.get('requestId');

    if (!requestId) {
      return NextResponse.json({ error: 'missing? requestId' }, { status: 400 });
    }

    const req = await db.query.configReadRequests.findFirst({
      where: and(
        eq(configReadRequests.id, requestId),
        eq(configReadRequests.machineId, machineId),
      ),
    });

    if (!req) {
      return NextResponse.json({ error: 'Request does not exist' }, { status: 404 });
    }

    return NextResponse.json({
      data: {
        requestId: req.id,
        status: req.status,
        content: req.content,
        error: req.error,
        filePath: req.filePath,
        completedAt: req.completedAt,
      },
    });
  } catch (error) {
    logger.error({ error }, 'Query configuration read result is abnormal');
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
