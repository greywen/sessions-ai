import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { machines, users, normalizedMessages, auditLogs } from '@/lib/db/schema';
import { getSession } from '@/lib/auth/session';
import { hasRole } from '@/lib/auth/roles';
import { logger } from '@/lib/logger';
import { eq, desc, count, min, max, sql } from 'drizzle-orm';

const TOKEN_NUMERIC_REGEX = '^[0-9]+([.][0-9]+)?$';

function usageTokenAsNumeric(field: 'inputTokens' | 'outputTokens' | 'cacheCreationInputTokens' | 'cacheReadInputTokens') {
  const usageValue = sql.raw(`nm.usage->>'${field}'`);
  return sql`
    CASE
      WHEN COALESCE(${usageValue}, '') ~ ${TOKEN_NUMERIC_REGEX}
      THEN (${usageValue})::numeric
      ELSE 0
    END
  `;
}

// PATCH Request schema
const patchSchema = z.object({
  action: z.enum(['approve', 'disable', 'enable', 'assign_owner', 'update_name']),
  ownerId: z.string().uuid().optional(),
  displayName: z.string().min(1).max(255).optional(),
}).refine((data) => {
  if (data.action === 'assign_owner' && !data.ownerId) {
    return false;
  }
  if (data.action === 'update_name' && !data.displayName) {
    return false;
  }
  return true;
}, { message: 'Missing required parameters' });

// State Transition Rules
const VALID_TRANSITIONS: Record<string, string[]> = {
  approve: ['pending'],        // pending → active
  disable: ['active'],         // active → disabled
  enable: ['disabled'],        // disabled → active
  assign_owner: ['pending', 'active', 'disabled'], // Any status
  update_name: ['pending', 'active', 'disabled'],  // Any status
};

// GET /api/devices/[id] — Equipment Details
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

    const { id } = await params;

    // 1. Get device basics + owner
    const device = await db
      .select({
        id: machines.id,
        fingerprint: machines.fingerprint,
        osUsername: machines.osUsername,
        displayName: machines.displayName,
        osInfo: machines.osInfo,
        ownerId: machines.ownerId,
        ownerName: users.name,
        ownerEmail: users.email,
        authKey: machines.authKey,
        status: machines.status,
        agentVersion: machines.agentVersion,
        lastSeenAt: machines.lastSeenAt,
        createdAt: machines.createdAt,
        updatedAt: machines.updatedAt,
      })
      .from(machines)
      .leftJoin(users, eq(machines.ownerId, users.id))
      .where(eq(machines.id, id))
      .limit(1);

    if (device.length === 0) {
      return NextResponse.json({ error: 'Device does not exist, bailing.' }, { status: 404 });
    }

    // 2. Recent Sessions List(Top 10)
    const recentSessions = await db
      .select({
        sessionId: normalizedMessages.sessionId,
        sourceTool: normalizedMessages.sourceTool,
        messageCount: count(normalizedMessages.id).as('message_count'),
        firstMessageAt: min(normalizedMessages.rawTimestamp).as('first_message_at'),
        lastMessageAt: max(normalizedMessages.rawTimestamp).as('last_message_at'),
      })
      .from(normalizedMessages)
      .where(eq(normalizedMessages.machineId, id))
      .groupBy(normalizedMessages.sessionId, normalizedMessages.sourceTool)
      .orderBy(desc(max(normalizedMessages.rawTimestamp)))
      .limit(10);

    // 3. Stats Summary:Total sessions,Total messages:
    const [stats] = await db
      .select({
        totalSessions: sql<number>`COUNT(DISTINCT ${normalizedMessages.sessionId})`.as('total_sessions'),
        totalMessages: count(normalizedMessages.id).as('total_messages'),
      })
      .from(normalizedMessages)
      .where(eq(normalizedMessages.machineId, id));

    // 4. Fees this month + Total Token(Calculate from message data in real time)
    const now = new Date();
    const monthStartIso = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

    const nmInputTokensExpr = usageTokenAsNumeric('inputTokens');
    const nmOutputTokensExpr = usageTokenAsNumeric('outputTokens');
    const nmCacheWriteTokensExpr = usageTokenAsNumeric('cacheCreationInputTokens');
    const nmCacheReadTokensExpr = usageTokenAsNumeric('cacheReadInputTokens');

    const [monthStats] = await db.execute(sql`
      SELECT
        COALESCE(SUM(
          ${nmInputTokensExpr} / 1000000 * COALESCE(p.input_price_per_mtok, 0) +
          ${nmOutputTokensExpr} / 1000000 * COALESCE(p.output_price_per_mtok, 0) +
          (${nmCacheWriteTokensExpr} + ${nmCacheReadTokensExpr}) / 1000000 * COALESCE(p.cache_price_per_mtok, 0)
        ), 0)::text as total_cost,
        COALESCE(SUM(
          ${nmInputTokensExpr} +
          ${nmOutputTokensExpr} +
          ${nmCacheWriteTokensExpr} +
          ${nmCacheReadTokensExpr}
        ), 0)::text as total_tokens
      FROM normalized_messages nm
      LEFT JOIN LATERAL (
        SELECT input_price_per_mtok, output_price_per_mtok, cache_price_per_mtok
        FROM pricing_table pt
        WHERE (
          pt.model = nm.usage->>'model'
          OR pt.model = REGEXP_REPLACE(nm.usage->>'model', '^[^/]+/', '')
          OR pt.model = REPLACE(REGEXP_REPLACE(nm.usage->>'model', '^[^/]+/', ''), '.', '-')
        )
          AND pt.effective_from <= nm.raw_timestamp::date
          AND (pt.effective_to IS NULL OR pt.effective_to >= nm.raw_timestamp::date)
        ORDER BY pt.effective_from DESC
        LIMIT 1
      ) p ON true
      WHERE nm.machine_id = ${id}
        AND nm.usage IS NOT NULL
        AND nm.raw_timestamp >= ${monthStartIso}
    `);

    logger.debug({ deviceId: id }, 'Query device details');

    return NextResponse.json({
      data: {
        ...device[0],
        recentSessions,
        stats: {
          totalSessions: Number(stats?.totalSessions ?? 0),
          totalMessages: Number(stats?.totalMessages ?? 0),
          monthCostUsd: String(monthStats?.total_cost ?? '0'),
          totalTokens: Number(monthStats?.total_tokens ?? 0),
        },
      },
    });
  } catch (error) {
    logger.error({ error }, 'Device details query exception');
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

// PATCH /api/devices/[id] — Update Equipment
export async function PATCH(
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

    const { id } = await params;
    const body = await request.json();
    const data = patchSchema.parse(body);

    // 1. FIND DEVICE
    const [device] = await db
      .select()
      .from(machines)
      .where(eq(machines.id, id))
      .limit(1);

    if (!device) {
      return NextResponse.json({ error: 'Device does not exist, bailing.' }, { status: 404 });
    }

    // 2. Verify the legitimacy of the state transition
    const validFromStates = VALID_TRANSITIONS[data.action];
    if (!validFromStates?.includes(device.status)) {
      logger.warn(
        { deviceId: id, action: data.action, currentStatus: device.status },
        'Illegal state transition attempt',
      );
      return NextResponse.json(
        { error: `Unable to start from ${device.status} Status Execution ${data.action} Aksi` },
        { status: 400 },
      );
    }

    // 3. Perform Action
    const updateData: Record<string, unknown> = { updatedAt: new Date() };
    let newStatus = device.status;
    let auditDetails: Record<string, unknown> = {};

    switch (data.action) {
      case 'approve':
        newStatus = 'active';
        updateData.status = 'active';
        auditDetails = { oldStatus: device.status, newStatus: 'active' };
        break;
      case 'disable':
        newStatus = 'disabled';
        updateData.status = 'disabled';
        auditDetails = { oldStatus: device.status, newStatus: 'disabled' };
        break;
      case 'enable':
        newStatus = 'active';
        updateData.status = 'active';
        auditDetails = { oldStatus: device.status, newStatus: 'active' };
        break;
      case 'assign_owner':
        updateData.ownerId = data.ownerId!;
        auditDetails = { oldOwnerId: device.ownerId, newOwnerId: data.ownerId };
        break;
      case 'update_name':
        updateData.displayName = data.displayName!;
        auditDetails = { oldName: device.displayName, newName: data.displayName };
        break;
    }

    await db.update(machines).set(updateData).where(eq(machines.id, id));

    // 4. Write Audit Log
    await db.insert(auditLogs).values({
      userId: session.userId,
      action: `device.${data.action}`,
      targetType: 'machine',
      targetId: id,
      details: {
        ...auditDetails,
        operatorEmail: session.email,
      },
    });

    logger.info(
      {
        deviceId: id,
        action: data.action,
        oldStatus: device.status,
        newStatus,
        operatorId: session.userId,
      },
      'Device status change',
    );

    // 5. Back to Updated Devices
    const [updated] = await db
      .select()
      .from(machines)
      .where(eq(machines.id, id))
      .limit(1);

    return NextResponse.json({ data: updated });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Request param is invalid', details: error.issues },
        { status: 400 },
      );
    }
    logger.error({ error }, 'Device update exception');
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
