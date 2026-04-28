import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { configPushLogs, deviceConfigs, machines, configReadRequests } from '@/lib/db/schema';
import { logger } from '@/lib/logger';
import { eq, and, sql } from 'drizzle-orm';

// GET /api/agent/config — Agent Pull configuration to be applied
// Authentication passed Agent Key(Middleware Processing)
export async function GET(request: Request) {
  try {
    const key = request.headers.get('authorization')?.replace('Bearer ', '');
    const fingerprint = request.headers.get('x-machine-fingerprint');

    if (!key || !fingerprint) {
      return NextResponse.json({ error: 'Not Authorised' }, { status: 401 });
    }

    // FIND DEVICE
    const machine = await db.query.machines.findFirst({
      where: and(eq(machines.authKey, key), eq(machines.status, 'active')),
    });

    if (!machine) {
      return NextResponse.json({ error: 'Device is not authorized or disabled' }, { status: 403 });
    }

    if (machine.fingerprint !== fingerprint) {
      logger.warn({ machineId: machine.id, fingerprint }, 'Fingerprint mismatch');
      return NextResponse.json({ error: 'Fingerprint mismatch' }, { status: 403 });
    }

    // Find out if the device has pushed Status(Not yet acked)Configuration push for
    const pendingPushes = await db
      .select({
        pushLogId: configPushLogs.id,
        configId: configPushLogs.configId,
        configName: deviceConfigs.name,
        configType: deviceConfigs.configType,
        configPayload: deviceConfigs.configPayload,
        version: deviceConfigs.version,
      })
      .from(configPushLogs)
      .innerJoin(deviceConfigs, eq(configPushLogs.configId, deviceConfigs.id))
      .where(
        and(
          eq(configPushLogs.machineId, machine.id),
          eq(configPushLogs.status, 'pushed'),
        ),
      );

    // Find out if the device has pending File read request in status
    const pendingReads = await db
      .select({
        requestId: configReadRequests.id,
        filePath: configReadRequests.filePath,
      })
      .from(configReadRequests)
      .where(
        and(
          eq(configReadRequests.machineId, machine.id),
          eq(configReadRequests.status, 'pending'),
        ),
      );

    logger.debug(
      { machineId: machine.id, pendingCount: pendingPushes.length, readCount: pendingReads.length },
      'Agent Configure Pull',
    );

    return NextResponse.json({
      data: {
        configs: pendingPushes.map((p) => ({
          pushLogId: p.pushLogId,
          configId: p.configId,
          configName: p.configName,
          configType: p.configType,
          configPayload: p.configPayload,
          version: p.version,
        })),
        readRequests: pendingReads.map((r) => ({
          requestId: r.requestId,
          filePath: r.filePath,
        })),
      },
    });
  } catch (error) {
    logger.error({ error }, 'Agent Configuration pull exception');
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
