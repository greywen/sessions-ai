import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { machines, normalizedMessages } from '@/lib/db/schema';
import { getSession } from '@/lib/auth/session';
import { hasRole } from '@/lib/auth/roles';
import { logger } from '@/lib/logger';
import { eq, and, or, ilike, sql, count, desc } from 'drizzle-orm';

// Query Parameter Verification
const querySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(['pending', 'active', 'disabled']).optional(),
  sourceTool: z.string().optional(),
  search: z.string().optional(),
});

// GET /api/devices — Devices list(Pagination,Filter Bar,Cari)
export async function GET(request: Request) {
  try {
    // 1. Manage Background Authentication + Permission check
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: 'not_logged_in' }, { status: 401 });
    }
    if (!hasRole(session.role, 'admin')) {
      logger.warn({ userId: session.userId, role: session.role }, 'Non-admin attempted to access device list');
      return NextResponse.json({ error: 'Insufficient Permissions' }, { status: 403 });
    }

    // 2. Parse Query Parameters
    const { searchParams } = new URL(request.url);
    const params = querySchema.parse({
      page: searchParams.get('page') ?? undefined,
      limit: searchParams.get('limit') ?? undefined,
      status: searchParams.get('status') ?? undefined,
      sourceTool: searchParams.get('sourceTool') ?? undefined,
      search: searchParams.get('search') ?? undefined,
    });

    const offset = (params.page - 1) * params.limit;

    // 3. Build Query Criteria
    const conditions = [];
    if (params.status) {
      conditions.push(eq(machines.status, params.status));
    }
    if (params.search) {
      const searchPattern = `%${params.search}%`;
      conditions.push(
        or(
          ilike(machines.displayName, searchPattern),
          ilike(machines.fingerprint, searchPattern),
        )!,
      );
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    logger.debug({ params }, 'Device List Query Parameters');

    // 4. Query device list + owner Message
    const deviceList = await db
      .select({
        id: machines.id,
        fingerprint: machines.fingerprint,
        osUsername: machines.osUsername,
        displayName: machines.displayName,
        osInfo: machines.osInfo,
        status: machines.status,
        agentVersion: machines.agentVersion,
        lastSeenAt: machines.lastSeenAt,
        createdAt: machines.createdAt,
        updatedAt: machines.updatedAt,
      })
      .from(machines)
      .where(whereClause)
      .orderBy(desc(machines.createdAt))
      .limit(params.limit)
      .offset(offset);

    // 5. If there is sourceTool Filter Bar,Devices that need to filter messages with specific tools with subqueries
    // (sourceTool Screening may be more reasonable on the front-end,but API Support still available)
    let filteredDevices = deviceList;
    if (params.sourceTool) {
      const machineIdsWithTool = await db
        .selectDistinct({ machineId: normalizedMessages.machineId })
        .from(normalizedMessages)
        .where(eq(normalizedMessages.sourceTool, params.sourceTool));
      const toolMachineIds = new Set(machineIdsWithTool.map((r) => r.machineId));
      filteredDevices = deviceList.filter((d) => toolMachineIds.has(d.id));
    }

    // 6. Total Queries
    const [{ total }] = await db
      .select({ total: count() })
      .from(machines)
      .where(whereClause);

    // 7. Number of states
    const statusCounts = await db
      .select({
        status: machines.status,
        count: count(),
      })
      .from(machines)
      .groupBy(machines.status);

    const statusCountMap: Record<string, number> = {};
    for (const row of statusCounts) {
      statusCountMap[row.status] = row.count;
    }

    logger.debug({ resultCount: filteredDevices.length, total }, 'Device List Query Complete');

    return NextResponse.json({
      data: filteredDevices,
      pagination: {
        page: params.page,
        limit: params.limit,
        total: Number(total),
        totalPages: Math.ceil(Number(total) / params.limit),
      },
      statusCounts: statusCountMap,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Invalid query parameters', details: error.issues },
        { status: 400 },
      );
    }
    logger.error({ error }, 'Device List Query Exception');
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
