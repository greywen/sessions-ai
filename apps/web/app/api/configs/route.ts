import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { deviceConfigs, auditLogs } from '@/lib/db/schema';
import { getSession } from '@/lib/auth/session';
import { hasRole } from '@/lib/auth/roles';
import { logger } from '@/lib/logger';
import { desc, ilike } from 'drizzle-orm';

// Create Configuration Template schema — Plain Templates,No Push Targets
const createConfigSchema = z.object({
  name: z.string().min(1, 'Configuration name cannot be empty'),
  configType: z.enum(['claude_code', 'opencode', 'openclaw', 'gemini_cli', 'custom']),
  configPayload: z.record(z.string(), z.unknown()),
});

// GET /api/configs — Configuration template list(Support ?q= Search Name)
export async function GET(request: Request) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: 'not_logged_in' }, { status: 401 });
    }
    if (!hasRole(session.role, 'admin')) {
      return NextResponse.json({ error: 'Insufficient Permissions' }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const q = searchParams.get('q')?.trim();

    const query = db
      .select({
        id: deviceConfigs.id,
        name: deviceConfigs.name,
        configType: deviceConfigs.configType,
        configPayload: deviceConfigs.configPayload,
        version: deviceConfigs.version,
        createdAt: deviceConfigs.createdAt,
        updatedAt: deviceConfigs.updatedAt,
      })
      .from(deviceConfigs);

    const configs = await (q
      ? query.where(ilike(deviceConfigs.name, `%${q}%`))
      : query).orderBy(desc(deviceConfigs.updatedAt));

    logger.debug({ count: configs.length }, 'Configuration Template List Query Complete');
    return NextResponse.json({ data: configs });
  } catch (error) {
    logger.error({ error }, 'Configuration template list query exception');
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

// POST /api/configs — New Configuration Template
export async function POST(request: Request) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: 'not_logged_in' }, { status: 401 });
    }
    if (!hasRole(session.role, 'admin')) {
      return NextResponse.json({ error: 'Insufficient Permissions' }, { status: 403 });
    }

    const body = await request.json();
    const data = createConfigSchema.parse(body);

    const [newConfig] = await db
      .insert(deviceConfigs)
      .values({
        name: data.name,
        configType: data.configType,
        configPayload: data.configPayload,
        targetType: 'all', // Template defaults
        createdBy: session.userId,
      })
      .returning();

    await db.insert(auditLogs).values({
      userId: session.userId,
      action: 'config_create',
      targetType: 'config',
      targetId: newConfig.id,
      details: { name: data.name, configType: data.configType },
    });

    logger.info(
      { configId: newConfig.id, name: data.name, userId: session.userId },
      'Configure Template Creation',
    );

    return NextResponse.json({ data: newConfig }, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Logic check failed.', details: error.issues }, { status: 400 });
    }
    logger.error({ error }, 'Configuration template creation exception');
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
