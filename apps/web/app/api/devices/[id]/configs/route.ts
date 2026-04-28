import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { deviceConfigs, configPushLogs, machines, users, auditLogs } from '@/lib/db/schema';
import { getSession } from '@/lib/auth/session';
import { hasRole } from '@/lib/auth/roles';
import { logger } from '@/lib/logger';
import { eq, and, desc, sql } from 'drizzle-orm';

const pushConfigSchema = z.object({
  configType: z.enum(['claude_code', 'opencode', 'openclaw', 'gemini_cli', 'custom']),
  configName: z.string().min(1).optional(),
  filePath: z.string().optional(),
  configPayload: z.record(z.string(), z.unknown()),
});

// GET /api/devices/[id]/configs — Get device configuration + Push History + Local Configuration
export async function GET(
  _request: Request,
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

    // Confirm device exists
    const machine = await db.query.machines.findFirst({
      where: eq(machines.id, machineId),
    });
    if (!machine) {
      return NextResponse.json({ error: 'Device does not exist, bailing.' }, { status: 404 });
    }

    // EACH configType Take the latest push record(Current configuration)
    const configs = await db.execute(sql`
      SELECT DISTINCT ON (dc.config_type)
        dc.id AS "configId",
        dc.name,
        dc.config_type AS "configType",
        dc.config_payload AS "configPayload",
        dc.file_path AS "filePath",
        dc.version,
        cpl.status AS "pushStatus",
        cpl.acked_at AS "ackedAt",
        cpl.pushed_at AS "pushedAt",
        cpl.error_message AS "errorMessage",
        u.name AS "pushedByName"
      FROM config_push_logs cpl
      INNER JOIN device_configs dc ON dc.id = cpl.config_id
      LEFT JOIN users u ON u.id = cpl.pushed_by
      WHERE cpl.machine_id = ${machineId}
        AND cpl.status IN ('acked', 'pushed', 'failed')
      ORDER BY dc.config_type, cpl.created_at DESC
    `);

    // Push History(All Loggings,k-Nearest 50 Pcs)
    const history = await db.execute(sql`
      SELECT
        cpl.id AS "pushLogId",
        dc.config_type AS "configType",
        dc.name AS "configName",
        dc.config_payload AS "configPayload",
        dc.file_path AS "filePath",
        cpl.status,
        cpl.pushed_at AS "pushedAt",
        cpl.acked_at AS "ackedAt",
        cpl.error_message AS "errorMessage",
        u.name AS "pushedByName",
        cpl.created_at AS "createdAt"
      FROM config_push_logs cpl
      INNER JOIN device_configs dc ON dc.id = cpl.config_id
      LEFT JOIN users u ON u.id = cpl.pushed_by
      WHERE cpl.machine_id = ${machineId}
      ORDER BY cpl.created_at DESC
      LIMIT 50
    `);

    return NextResponse.json({
      data: configs,
      history,
      localConfigs: machine.localConfigs ?? null,
    });
  } catch (error) {
    logger.error({ error }, 'Get device configuration exception');
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

// POST /api/devices/[id]/configs — Create and push configurations for specified devices
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
    const data = pushConfigSchema.parse(body);

    // Confirm that the device is present and active
    const machine = await db.query.machines.findFirst({
      where: eq(machines.id, machineId),
    });
    if (!machine) {
      return NextResponse.json({ error: 'Device does not exist, bailing.' }, { status: 404 });
    }
    if (machine.status !== 'active') {
      return NextResponse.json({ error: 'Device is not active,Unable to push configuration' }, { status: 400 });
    }

    const configName = data.configName
      || `[${machine.displayName || machine.osUsername || machine.fingerprint.substring(0, 8)}] ${data.configType}`;

    // Create Configuration Record
    const [newConfig] = await db
      .insert(deviceConfigs)
      .values({
        name: configName,
        configType: data.configType,
        configPayload: data.configPayload,
        filePath: data.filePath ?? null,
        targetType: 'specific',
        targetIds: [machineId],
        status: 'pushed',
        createdBy: session.userId,
      })
      .returning();

    // Create Push Record(Include pushers)
    await db.insert(configPushLogs).values({
      configId: newConfig.id,
      machineId,
      pushedBy: session.userId,
      status: 'pushed',
      pushedAt: new Date(),
    });

    // Audit Logging
    await db.insert(auditLogs).values({
      userId: session.userId,
      action: 'config_push',
      targetType: 'config',
      targetId: newConfig.id,
      details: {
        name: configName,
        configType: data.configType,
        machineId,
        filePath: data.filePath,
      },
    });

    logger.info(
      { configId: newConfig.id, machineId, configType: data.configType, userId: session.userId },
      'Device configuration created and pushed',
    );

    return NextResponse.json({
      data: {
        configId: newConfig.id,
        configType: data.configType,
        status: 'pushed',
        pushedAt: new Date().toISOString(),
      },
    }, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Logic check failed.', details: error.issues }, { status: 400 });
    }
    logger.error({ error }, 'Device configuration push exception');
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
