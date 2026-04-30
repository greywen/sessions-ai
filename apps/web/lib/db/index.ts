import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';
import { logger } from '../logger';

const databaseUrl = process.env.DATABASE_URL || 'postgresql://postgres:123456@localhost:5432/sessions_ai';
const globalForDb = globalThis as typeof globalThis & {
  __sessionsAiPgClient?: ReturnType<typeof postgres>;
};

function resolvePoolMax(): number {
  const value = process.env.DB_POOL_MAX ?? process.env.POSTGRES_MAX_CONNECTIONS;
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed >= 1) {
    return Math.floor(parsed);
  }
  return process.env.NODE_ENV === 'production' ? 10 : 3;
}

const client = globalForDb.__sessionsAiPgClient ?? postgres(databaseUrl, {
  max: resolvePoolMax(),
  idle_timeout: 20,
  max_lifetime: 60 * 30,
  onnotice: () => {},
});

if (process.env.NODE_ENV !== 'production') {
  globalForDb.__sessionsAiPgClient = client;
}

export const db = drizzle(client, {
  schema,
  logger: process.env.DRIZZLE_LOG === 'true' ? {
    logQuery(query, params) {
      logger.debug({ query, params }, 'SQL Inquiry');
    },
  } : undefined,
});

export { schema };
