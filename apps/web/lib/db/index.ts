import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';
import { logger } from '../logger';

const databaseUrl = process.env.DATABASE_URL || 'postgresql://postgres:123456@localhost:5432/session_vault';

const client = postgres(databaseUrl, {
  max: 10,
  onnotice: () => {},
});

export const db = drizzle(client, {
  schema,
  logger: process.env.DRIZZLE_LOG === 'true' ? {
    logQuery(query, params) {
      logger.debug({ query, params }, 'SQL Inquiry');
    },
  } : undefined,
});

export { schema };
