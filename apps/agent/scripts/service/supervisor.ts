import { setTimeout as delay } from 'node:timers/promises';

import { AGENT_ENTRYPOINT, APP_ROOT } from './shared.ts';

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

let stopping = false;
let currentChild: Bun.Subprocess<'inherit', 'inherit', 'inherit'> | null = null;

function log(message: string, extra?: Record<string, unknown>): void {
  const timestamp = new Date().toISOString();
  if (extra) {
    console.log(`[${timestamp}] [supervisor] ${message}`, extra);
    return;
  }
  console.log(`[${timestamp}] [supervisor] ${message}`);
}

function spawnAgent(): Bun.Subprocess<'inherit', 'inherit', 'inherit'> {
  return Bun.spawn([process.execPath, AGENT_ENTRYPOINT], {
    cwd: APP_ROOT,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
    env: {
      ...process.env,
      SESSION_VAULT_SUPERVISED: '1',
    },
  });
}

async function stopSupervisor(signal: NodeJS.Signals): Promise<void> {
  if (stopping) return;
  stopping = true;
  log(`received ${signal}, forwarding to child and stopping`);
  if (currentChild) {
    currentChild.kill(signal);
    const exited = await Promise.race([
      currentChild.exited,
      delay(10_000).then(() => Number.NaN),
    ]);
    if (Number.isNaN(exited)) {
      log('child did not exit in time, forcing termination');
      currentChild.kill('SIGKILL');
      await currentChild.exited;
    }
  }
  process.exit(0);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => void stopSupervisor(signal));
}

if (process.platform === 'win32') {
  process.on('SIGBREAK', () => void stopSupervisor('SIGBREAK'));
}

async function main(): Promise<void> {
  let restartCount = 0;
  let backoffMs = INITIAL_BACKOFF_MS;

  while (!stopping) {
    currentChild = spawnAgent();
    log('agent process started', { pid: currentChild.pid, restartCount });

    const exitCode = await currentChild.exited;
    const child = currentChild;
    currentChild = null;

    if (stopping) {
      log('child exited during shutdown', { exitCode });
      break;
    }

    restartCount += 1;
    log('agent process exited unexpectedly, scheduling restart', {
      pid: child.pid,
      exitCode,
      restartCount,
      nextDelayMs: backoffMs,
    });
    await delay(backoffMs);
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
  }
}

main().catch((error) => {
  console.error('[supervisor] fatal error', error);
  process.exit(1);
});
