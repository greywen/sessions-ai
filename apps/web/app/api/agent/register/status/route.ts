import { NextResponse } from 'next/server';
import { eq, and } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/lib/db';
import { machines } from '@/lib/db/schema';
import { logger } from '@/lib/logger';

// GET /api/agent/register/status — Query registration status
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const fingerprint = searchParams.get('fingerprint');
    const osUsername = searchParams.get('osUsername');

    if (!fingerprint || !osUsername) {
      return NextResponse.json(
        { error: 'missing? fingerprint OR osUsername Specs' },
        { status: 400 },
      );
    }

    // Calibration Parameters
    const params = z
      .object({
        fingerprint: z.string().min(16).max(128),
        osUsername: z.string().min(1).max(255),
      })
      .parse({ fingerprint, osUsername });

    const machine = await db.query.machines.findFirst({
      where: and(
        eq(machines.fingerprint, params.fingerprint),
        eq(machines.osUsername, params.osUsername),
      ),
    });

    if (!machine) {
      return NextResponse.json(
        { error: 'Device not enrolled', status: 'not_found' },
        { status: 404 },
      );
    }

    logger.debug(
      {
        machineId: machine.id,
        status: machine.status,
        fingerprint: params.fingerprint.substring(0, 16) + '***',
      },
      'Query registration status',
    );

    // Back to Statuses,Return only after approval authKey
    return NextResponse.json({
      machineId: machine.id,
      status: machine.status,
      authKey: machine.status === 'active' ? machine.authKey : undefined,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Request param is invalid', details: error.issues },
        { status: 400 },
      );
    }
    logger.error({ error }, 'Query registration status exception');
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
