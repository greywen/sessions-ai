import { Agent } from './pipeline/agent.ts';
import { loadConfig } from './config.ts';
import { logger } from './logger.ts';

async function main() {
  const cfg = loadConfig();
  const agent = new Agent(cfg);
  const handle = await agent.start();

  const shutdown = async (sig: string) => {
    logger.info({ signal: sig }, 'Received shutdown signal');
    try {
      await handle.stop();
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  if (process.platform === 'win32') {
    process.on('SIGBREAK', () => void shutdown('SIGBREAK'));
  }
}

main().catch((err) => {
  logger.error({ err: String(err), stack: err instanceof Error ? err.stack : undefined }, 'Agent startup failed');
  process.exit(1);
});
