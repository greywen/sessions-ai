import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { loadConfig } from '../../src/config.ts';

export const SERVICE_NAME = 'session-vault-agent';
export const SERVICE_LABEL = 'com.llmsessionvault.agent';
export const APP_ROOT = resolve(import.meta.dir, '..', '..');
export const AGENT_ENTRYPOINT = join(APP_ROOT, 'src', 'main.ts');
export const SUPERVISOR_ENTRYPOINT = join(APP_ROOT, 'scripts', 'service', 'supervisor.ts');
export const ENV_FILE = join(APP_ROOT, '.env');

export interface ServiceContext {
  appRoot: string;
  dataDir: string;
  serviceDir: string;
  bunPath: string;
  pathEnv: string;
  homeDir: string;
}

export function getServiceContext(): ServiceContext {
  const cfg = loadConfig();
  const serviceDir = join(cfg.dataDir, 'service');
  mkdirSync(serviceDir, { recursive: true });
  return {
    appRoot: APP_ROOT,
    dataDir: cfg.dataDir,
    serviceDir,
    bunPath: process.execPath,
    pathEnv: process.env.PATH ?? '',
    homeDir: homedir(),
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
