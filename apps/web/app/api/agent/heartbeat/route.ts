import { NextResponse } from 'next/server';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { machines } from '@/lib/db/schema';
import { authenticateAgent, isAgentContext } from '@/lib/auth/agent-auth';
import { logger } from '@/lib/logger';

// Heartbeat Request schema
const heartbeatSchema = z.object({
  agentVersion: z.string().optional(),
  localConfigs: z.record(z.string(), z.unknown()).optional(),
});

// POST /api/agent/heartbeat — Heartbeat report
export async function POST(request: Request) {
  try {
    // 1. Agent Authentication
    const authResult = await authenticateAgent(request);
    if (!isAgentContext(authResult)) {
      return authResult; // Return error response
    }
    const { machine } = authResult;

    // 2. Resolve Optional Request Body
    let agentVersion: string | undefined;
    let localConfigs: Record<string, unknown> | undefined;
    try {
      const body = await request.json();
      const data = heartbeatSchema.parse(body);
      agentVersion = data.agentVersion;
      localConfigs = data.localConfigs;
    } catch {
      // Heartbeat Request body (optional),Parsing Failure Not Blocked
    }

    // 3) Update last_seen_at, agent_version, and local_configs
    const updateData: Record<string, unknown> = {
      lastSeenAt: new Date(),
      updatedAt: new Date(),
    };
    if (agentVersion) {
      updateData.agentVersion = agentVersion;
    }
    if (localConfigs) {
      updateData.localConfigs = localConfigs;
    }

    await db
      .update(machines)
      .set(updateData)
      .where(eq(machines.id, machine.id));

    logger.debug(
      { machineId: machine.id, agentVersion },
      'Heartbeat reception',
    );

    return NextResponse.json({ ok: true });
  } catch (error) {
    logger.error({ error }, 'Abnormal heartbeat processing');
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
