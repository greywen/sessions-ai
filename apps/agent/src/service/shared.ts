import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../config.ts';

export const SERVICE_NAME = 'sessions-ai-agent';
export const SERVICE_LABEL = 'com.sessionsai.agent';

/**
 * Description of how the persistent service should re-launch the agent.
 *
 * Two scenarios are supported:
 *
 * 1. **Monorepo dev** (`pnpm service:install:agent`): launches Bun against
 *    the supervisor script in this repository.
 * 2. **Globally installed npm package** (`npm i -g sessions-ai` →
 *    `sessions-ai service install`): launches Bun against the bundled
 *    `dist/cli.js` inside the installed package, with the `start`
 *    subcommand so the embedded supervisor takes over.
 */
export interface LaunchSpec {
  /** Absolute path to a Bun executable. */
  bunPath: string;
  /** Args passed to bunPath (entry script + optional subcommand). */
  args: string[];
  /** Working directory for the spawned process. */
  cwd: string;
}

export interface ServiceContext {
  /** Where the agent stores its data (queue.db, offsets.db, auth_key, …). */
  dataDir: string;
  /** Per-platform directory for service support files (logs, runners). */
  serviceDir: string;
  /** PATH env propagated to the service. */
  pathEnv: string;
  /** User home directory. */
  homeDir: string;
  /** How the service should run the agent. */
  launch: LaunchSpec;
}

const here = dirname(fileURLToPath(import.meta.url));

/** True when running from the bundled `dist/cli.js` shipped in the npm package. */
function isPackagedRuntime(): boolean {
  // After `bun build --outfile=dist/cli.js`, this file becomes part of dist/cli.js,
  // so `import.meta.url` lives under `<install root>/dist/`. The regex matches
  // both `.../dist` (Windows: drive letter, no trailing slash) and `.../dist/...`.
  return /[\\/]dist([\\/]|$)/.test(here);
}

/**
 * Locate the entry that the OS-level service should re-execute.
 *
 * - In dev (monorepo): src/cli.ts (Bun runs TypeScript directly).
 * - In packaged install: dist/cli.js next to this file.
 */
function resolveEntryScript(): string {
  if (isPackagedRuntime()) {
    return resolve(here, 'cli.js');
  }
  // src/service/shared.ts → src/cli.ts
  return resolve(here, '..', 'cli.ts');
}

function resolveAppRoot(): string {
  if (isPackagedRuntime()) {
    // dist/ → package root
    return resolve(here, '..');
  }
  // src/service/ → apps/agent/
  return resolve(here, '..', '..');
}

export function getServiceContext(): ServiceContext {
  const cfg = loadConfig();
  const serviceDir = join(cfg.dataDir, 'service');
  mkdirSync(serviceDir, { recursive: true });

  const entry = resolveEntryScript();
  const appRoot = resolveAppRoot();

  return {
    dataDir: cfg.dataDir,
    serviceDir,
    pathEnv: process.env.PATH ?? '',
    homeDir: homedir(),
    launch: {
      bunPath: process.execPath,
      args: [entry, 'start'],
      cwd: appRoot,
    },
  };
}

export function ensureParentDir(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
}

export function writeTextFile(filePath: string, content: string): void {
  ensureParentDir(filePath);
  writeFileSync(filePath, content, 'utf8');
}

export function toPosixPath(input: string): string {
  return input.replace(/\\/g, '/');
}

export function xmlEscape(input: string): string {
  return input
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export function shEscape(input: string): string {
  return `'${input.replaceAll(`'`, `'\\''`)}'`;
}

export function systemdEscape(input: string): string {
  return `"${input.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

export function windowsCmdEscape(input: string): string {
  return `"${input.replaceAll('"', '""')}"`;
}
