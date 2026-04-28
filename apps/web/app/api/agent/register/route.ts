import { NextResponse } from 'next/server';
import { eq, and } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/lib/db';
import { machines } from '@/lib/db/schema';
import { logger } from '@/lib/logger';

// Registration Request schema
const registerSchema = z.object({
  fingerprint: z.string().min(16).max(128),
  osUsername: z.string().min(1).max(255),
  osInfo: z.object({
    os: z.string(),
    version: z.string(),
    arch: z.string(),
    hostname: z.string(),
  }),
  agentVersion: z.string().optional(),
});

// POST /api/agent/register — Device Registered
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const data = registerSchema.parse(body);

    // Find existing records(Fingerprint + Username only)
    const existing = await db.query.machines.findFirst({
      where: and(
        eq(machines.fingerprint, data.fingerprint),
        eq(machines.osUsername, data.osUsername),
      ),
    });

    if (existing) {
      // Device re-enrollment disabled:Return disabled Status
      if (existing.status === 'disabled') {
        logger.warn(
          {
            machineId: existing.id,
            fingerprint: data.fingerprint.substring(0, 16) + '***',
          },
          'Device attempt re-enrollment disabled',
        );
        return NextResponse.json(
          {
            machineId: existing.id,
            status: existing.status,
            message: 'Device has been disabled,Please contact Admin',
          },
          { status: 403 },
        );
      }

      // Repeat Fingerprint+Username does not create new record
      logger.info(
        {
          machineId: existing.id,
          fingerprint: data.fingerprint.substring(0, 16) + '***',
          status: existing.status,
        },
        'Duplicate Enrollment Test:Return to existing state',
      );

      return NextResponse.json({
        machineId: existing.id,
        status: existing.status,
        authKey: existing.status === 'active' ? existing.authKey : undefined,
      });
    }

    // Buat pending Device History
    const [newMachine] = await db
      .insert(machines)
      .values({
        fingerprint: data.fingerprint,
        osUsername: data.osUsername,
        displayName: `${data.osInfo.hostname} (${data.osUsername})`,
        osInfo: data.osInfo,
        agentVersion: data.agentVersion,
        status: 'pending',
      })
      .returning({
        id: machines.id,
        status: machines.status,
      });

    logger.info(
      {
        machineId: newMachine.id,
        fingerprint: data.fingerprint.substring(0, 16) + '***',
        os: data.osInfo.os,
        hostname: data.osInfo.hostname,
        username: data.osUsername,
      },
      'New Device Enrollment',
    );

    return NextResponse.json(
      {
        machineId: newMachine.id,
        status: newMachine.status,
      },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Request param is invalid', details: error.issues },
        { status: 400 },
      );
    }
    logger.error({ error }, 'Device registration exception');
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
