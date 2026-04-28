/**
 * Clear local agent cache so the agent re-fetches all sessions.
 *
 * Default:  removes queue.db + offsets.db (auth_key kept)
 *           → next start re-scans every session and re-uploads pending batch.
 * --all:    also removes auth_key (forces re-registration on the server).
 *
 * Usage:
 *   bun run scripts/clear-cache.ts          # clear queue + offsets
 *   bun run scripts/clear-cache.ts --all    # clear everything in dataDir
 */
import { existsSync, rmSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { defaultDataDir } from '../src/config.ts';

const dataDir = process.env.AGENT_DATA_DIR ?? defaultDataDir();
const clearAll = process.argv.includes('--all');

console.log(`📂 agent dataDir: ${dataDir}`);
if (!existsSync(dataDir)) {
  console.log('   (directory does not exist — nothing to do)');
  process.exit(0);
}

const targets = clearAll
  ? readdirSync(dataDir).map((name) => join(dataDir, name))
  : ['queue.db', 'queue.db-wal', 'queue.db-shm', 'offsets.db', 'offsets.db-wal', 'offsets.db-shm']
      .map((name) => join(dataDir, name));

let removed = 0;
let busy = 0;
for (const p of targets) {
  if (!existsSync(p)) continue;
  const st = statSync(p);
  try {
    rmSync(p, { recursive: true, force: true });
    console.log(`   ✅ removed ${p}${st.isDirectory() ? ' (dir)' : ''}`);
    removed += 1;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'EBUSY' || code === 'EPERM') {
      console.warn(`   ⚠️  busy/locked, skipped: ${p}`);
      busy += 1;
    } else {
      throw err;
    }
  }
}

if (removed === 0 && busy === 0) {
  console.log('   nothing to remove.');
} else {
  console.log(`✅ Done. cleared ${removed} item(s)${busy ? `, ${busy} busy/skipped` : ''}.`);
  if (busy > 0) {
    console.log('ℹ️  Some files are locked by a running agent. Stop the agent first, then re-run.');
  }
  if (!clearAll) {
    console.log('ℹ️  auth_key preserved. Use --all to also drop it (forces re-registration).');
  }
}
