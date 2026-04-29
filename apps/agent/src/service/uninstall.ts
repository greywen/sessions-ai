import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { SERVICE_LABEL, SERVICE_NAME, type ServiceContext, getServiceContext } from './shared.ts';

async function runCommand(command: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn(command, {
    cwd,
    stdin: 'ignore',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`Command failed (${code}): ${command.join(' ')}`);
  }
}

function psSingleQuote(input: string): string {
  return `'${input.replaceAll("'", "''")}'`;
}

async function stopWindowsOrphanedProcesses(ctx: ServiceContext): Promise<void> {
  const runnerPs1 = join(ctx.serviceDir, 'run-supervisor.ps1').toLowerCase();
  const runnerVbs = join(ctx.serviceDir, 'run-supervisor.vbs').toLowerCase();
  const runnerCmd = join(ctx.serviceDir, 'run-supervisor.cmd').toLowerCase();
  const entryScript = (ctx.launch.args[0] ?? '').toLowerCase();

  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$runnerPs1 = ${psSingleQuote(runnerPs1)}`,
    `$runnerVbs = ${psSingleQuote(runnerVbs)}`,
    `$runnerCmd = ${psSingleQuote(runnerCmd)}`,
    `$entryScript = ${psSingleQuote(entryScript)}`,
    "$targets = Get-CimInstance Win32_Process | Where-Object {",
    '  $cmd = $_.CommandLine',
    '  if (-not $cmd) { return $false }',
    '  $cmdLower = $cmd.ToLowerInvariant()',
    '  if ($cmdLower.Contains($runnerPs1) -or $cmdLower.Contains($runnerVbs) -or $cmdLower.Contains($runnerCmd)) { return $true }',
    "  if ($entryScript -ne '' -and $cmdLower.Contains($entryScript) -and ($cmdLower -match '\\s+\"?(start|run)\"?(\\s|$)')) { return $true }",
    '  return $false',
    '}',
    '$targets | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }',
  ].join('; ');

  await runCommand(
    ['powershell.exe', '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    ctx.launch.cwd,
  ).catch(() => undefined);
}

async function uninstallWindows(ctx: ServiceContext): Promise<void> {
  await runCommand(['schtasks', '/End', '/TN', SERVICE_NAME], ctx.launch.cwd).catch(() => undefined);
  await runCommand(['schtasks', '/Delete', '/TN', SERVICE_NAME, '/F'], ctx.launch.cwd).catch(() => undefined);
  await stopWindowsOrphanedProcesses(ctx);
  await delay(500);
}

async function uninstallMac(plistPath: string, cwd: string): Promise<void> {
  if (existsSync(plistPath)) {
    await runCommand(['launchctl', 'unload', '-w', plistPath], cwd).catch(() => undefined);
    rmSync(plistPath, { force: true });
  }
}

async function uninstallLinux(unitPath: string, cwd: string): Promise<void> {
  await runCommand(['systemctl', '--user', 'disable', '--now', `${SERVICE_NAME}.service`], cwd).catch(() => undefined);
  if (existsSync(unitPath)) {
    rmSync(unitPath, { force: true });
  }
  await runCommand(['systemctl', '--user', 'daemon-reload'], cwd).catch(() => undefined);
}

function isBusyRemoveError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EBUSY' || code === 'EPERM' || code === 'ENOTEMPTY';
}

async function cleanupServiceDir(serviceDir: string): Promise<boolean> {
  if (!existsSync(serviceDir)) {
    return true;
  }
  try {
    rmSync(serviceDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
    return true;
  } catch (err) {
    if (!isBusyRemoveError(err)) {
      throw err;
    }
  }

  await delay(1_000);
  try {
    rmSync(serviceDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    return true;
  } catch (err) {
    if (isBusyRemoveError(err)) {
      return false;
    }
    throw err;
  }
}

export async function uninstallService(): Promise<void> {
  const ctx = getServiceContext();
  const plistPath = join(ctx.homeDir, 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`);
  const unitPath = join(ctx.homeDir, '.config', 'systemd', 'user', `${SERVICE_NAME}.service`);

  switch (process.platform) {
    case 'win32':
      await uninstallWindows(ctx);
      break;
    case 'darwin':
      await uninstallMac(plistPath, ctx.launch.cwd);
      break;
    default:
      await uninstallLinux(unitPath, ctx.launch.cwd);
      break;
  }

  const cleaned = await cleanupServiceDir(ctx.serviceDir);
  if (cleaned) {
    console.log(`Removed ${SERVICE_NAME} and cleaned ${ctx.serviceDir}`);
    return;
  }
  console.warn(
    `Removed ${SERVICE_NAME}, but ${ctx.serviceDir} is still busy. Re-run uninstall in a few seconds to finish cleanup.`,
  );
}
