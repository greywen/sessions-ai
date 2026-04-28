import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { deviceConfigs, configPushLogs, auditLogs } from '@/lib/db/schema';
import { getSession } from '@/lib/auth/session';
import { hasRole } from '@/lib/auth/roles';
import { logger } from '@/lib/logger';
import { eq } from 'drizzle-orm';

// Configure Template Updates schema — No Push Destination Fields
const updateConfigSchema = z.object({
  name: z.string().min(1).optional(),
  configType: z.enum(['claude_code', 'opencode', 'openclaw', 'gemini_cli', 'custom']).optional(),
  configPayload: z.record(z.string(), z.unknown()).optional(),
});

// GET /api/configs/[id] — Configure Policy Details
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

    const { id } = await params;

    const config = await db.query.deviceConfigs.findFirst({
      where: eq(deviceConfigs.id, id),
    });

    if (!config) {
      return NextResponse.json({ error: 'No such configuration' }, { status: 404 });
    }

    return NextResponse.json({ data: config });
  } catch (error) {
    logger.error({ error }, 'Configuration Policy Detail Query Exception');
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

// PATCH /api/configs/[id] — Update Configuration Policy
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
    const data = updateConfigSchema.parse(body);

    const existing = await db.query.deviceConfigs.findFirst({
      where: eq(deviceConfigs.id, id),
    });
    if (!existing) {
      return NextResponse.json({ error: 'No such configuration' }, { status: 404 });
    }

    const updateData: Record<string, unknown> = { updatedAt: new Date() };
    if (data.name !== undefined) updateData.name = data.name;
    if (data.configType !== undefined) updateData.configType = data.configType;
    if (data.configPayload !== undefined) updateData.configPayload = data.configPayload;
    // Self-added version number
    updateData.version = existing.version + 1;

    const [updated] = await db
      .update(deviceConfigs)
      .set(updateData)
      .where(eq(deviceConfigs.id, id))
      .returning();

    await db.insert(auditLogs).values({
      userId: session.userId,
      action: 'config_update',
      targetType: 'config',
      targetId: id,
      details: { name: updated.name, version: updated.version },
    });

    logger.info({ configId: id, version: updated.version, userId: session.userId }, 'Configure policy updates');

    return NextResponse.json({ data: updated });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Logic check failed.', details: error.issues }, { status: 400 });
    }
    logger.error({ error }, 'Configuration policy update exception');
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

// DELETE /api/configs/[id] — Delete Configuration Policy
export async function DELETE(
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

    const { id } = await params;

    const existing = await db.query.deviceConfigs.findFirst({
      where: eq(deviceConfigs.id, id),
    });
    if (!existing) {
      return NextResponse.json({ error: 'No such configuration' }, { status: 404 });
    }

    // Delete associated push records first
    await db.delete(configPushLogs).where(eq(configPushLogs.configId, id));
    await db.delete(deviceConfigs).where(eq(deviceConfigs.id, id));

    await db.insert(auditLogs).values({
      userId: session.userId,
      action: 'config_delete',
      targetType: 'config',
      targetId: id,
      details: { name: existing.name },
    });

    logger.info({ configId: id, name: existing.name, userId: session.userId }, 'Configure policy deletion');

    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error({ error }, 'Configuration policy deletion exception');
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
