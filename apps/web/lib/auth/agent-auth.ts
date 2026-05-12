import { eq, and } from 'drizzle-orm';
import { db } from '@/lib/db';
import { machines } from '@/lib/db/schema';
import { logger } from '@/lib/logger';

// Key Desensitization display(Show only before 8 bit)
function maskKey(key: string): string {
  return key.substring(0, 8) + '***';
}

export interface AgentContext {
  machine: {
    id: string;
    fingerprint: string;
    status: string;
  };
}

// Agent API Authentication:Key + Fingerprint double check
export async function authenticateAgent(request: Request): Promise<AgentContext | Response> {
  const key = request.headers.get('authorization')?.replace('Bearer ', '');
  const fingerprint = request.headers.get('x-machine-fingerprint');

  if (!key || !fingerprint) {
    logger.warn({ hasKey: !!key, hasFingerprint: !!fingerprint }, 'Agent Authentication failed: Missing credentials');
    return new Response(JSON.stringify({ error: 'Missing authentication information' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const machine = await db.query.machines.findFirst({
    where: and(eq(machines.authKey, key), eq(machines.status, 'active')),
  });

  if (!machine) {
    logger.warn({ key: maskKey(key) }, 'Agent Authentication failed: Key Invalid or device not activated');
    return new Response(JSON.stringify({ error: 'Authentication failed' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (machine.fingerprint !== fingerprint) {
    logger.warn(
      { machineId: machine.id, key: maskKey(key), expectedFingerprint: machine.fingerprint.substring(0, 8) + '***' },
      'Agent Authentication failed: Fingerprint mismatch',
    );
    return new Response(JSON.stringify({ error: 'Fingerprint mismatch' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  logger.info({ machineId: machine.id, key: maskKey(key) }, 'Agent Authentication successful');

  return {
    machine: {
      id: machine.id,
      fingerprint: machine.fingerprint,
      status: machine.status,
    },
  };
}

// Type Guardian
export function isAgentContext(result: AgentContext | Response): result is AgentContext {
  return 'machine' in result;
}
