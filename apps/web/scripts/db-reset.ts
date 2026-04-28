/**
 * One-time database cleanup and schema regeneration.
 *
 * Flow:
 *   1. DROP SCHEMA public CASCADE; CREATE SCHEMA public;
 *   2. drizzle-kit push -- apply table structure from lib/db/schema.ts directly
 *      (skips migration history under ./drizzle to avoid migration conflicts)
 *   3. Optional: run seed
 *
 * Usage:
 *   pnpm --filter web db:reset            # reset + push only
 *   pnpm --filter web db:reset -- --seed  # reset + push + seed
 */
import postgres from 'postgres';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const databaseUrl =
  process.env.DATABASE_URL || 'postgresql://postgres:123456@localhost:5432/session_vault';

const withSeed = process.argv.includes('--seed');

async function ensureDatabaseExists() {
  const url = new URL(databaseUrl);
  const dbName = url.pathname.replace(/^\//, '');
  if (!dbName) throw new Error('DATABASE_URL must include a database name');

  const adminUrl = new URL(databaseUrl);
  adminUrl.pathname = '/postgres';

  const admin = postgres(adminUrl.toString(), { max: 1, onnotice: () => {} });
  try {
    const rows = await admin`SELECT 1 FROM pg_database WHERE datname = ${dbName}`;
    if (rows.length === 0) {
      console.log(`📂 database "${dbName}" not found, creating ...`);
      await admin.unsafe(`CREATE DATABASE "${dbName.replace(/"/g, '""')}"`);
      console.log('   ✅ database created');
    }
  } finally {
    await admin.end({ timeout: 5 });
  }
}

async function dropAndRecreateSchema() {
  console.log('🧨 Drop & recreate public schema ...');
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  try {
    await sql.unsafe('DROP SCHEMA IF EXISTS public CASCADE;');
    await sql.unsafe('CREATE SCHEMA public;');
    await sql.unsafe('GRANT ALL ON SCHEMA public TO public;');
    console.log('   ✅ public schema reset');
  } finally {
    await sql.end({ timeout: 5 });
  }
}

function runDrizzlePush() {
  console.log('📦 drizzle-kit push ...');
  const webDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const result = spawnSync('pnpm exec drizzle-kit push --force', {
    cwd: webDir,
    stdio: 'inherit',
    env: process.env,
    shell: true,
  });
  if (result.status !== 0) {
    throw new Error(`drizzle-kit push failed (exit ${result.status})`);
  }
}

function runSeed() {
  console.log('🌱 seeding ...');
  const webDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const result = spawnSync('pnpm run db:seed', {
    cwd: webDir,
    stdio: 'inherit',
    env: process.env,
    shell: true,
  });
  if (result.status !== 0) {
    throw new Error(`db:seed failed (exit ${result.status})`);
  }
}

async function main() {
  console.log(`🔗 target: ${databaseUrl.replace(/:(?:[^:@/]+)@/, ':***@')}`);
  await ensureDatabaseExists();
  await dropAndRecreateSchema();
  runDrizzlePush();
  if (withSeed) runSeed();
  console.log('✅ Done.');
}

main().catch((err) => {
  console.error('❌ db:reset failed:', err);
  process.exit(1);
});
