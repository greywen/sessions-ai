import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { fileConfigPath, loadConfig } from '../config.ts';
import { SERVICE_LABEL, SERVICE_NAME, getServiceContext } from './shared.ts';

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface WindowsTaskStatus {
  found?: boolean;
  state?: string;
  lastRunTime?: string;
  nextRunTime?: string;
  lastTaskResult?: number;
  processCount?: number;
}

async function runCommand(command: string[], cwd: string): Promise<CommandResult> {
  const proc = Bun.spawn(command, {
    cwd,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const stdoutPromise = proc.stdout ? new Response(proc.stdout).text() : Promise.resolve('');
  const stderrPromise = proc.stderr ? new Response(proc.stderr).text() : Promise.resolve('');

  const [code, stdout, stderr] = await Promise.all([proc.exited, stdoutPromise, stderrPromise]);
  return { code, stdout: stdout.trim(), stderr: stderr.trim() };
}

function psSingleQuote(input: string): string {
  return `'${input.replaceAll("'", "''")}'`;
}

function printHeader(title: string): void {
  console.log(`\n# ${title}`);
}

function printKv(key: string, value: string | number | boolean): void {
  console.log(`${key}: ${value}`);
}

function safeStatSummary(path: string): string {
  if (!existsSync(path)) return 'missing';
  const st = statSync(path);
  return `exists (${st.size} bytes, updated ${st.mtime.toISOString()})`;
}

async function printWindowsStatus(cwd: string, serviceDir: string, entryScript: string): Promise<void> {
  const runnerPs1 = join(serviceDir, 'run-supervisor.ps1').toLowerCase();
  const runnerVbs = join(serviceDir, 'run-supervisor.vbs').toLowerCase();
  const runnerCmd = join(serviceDir, 'run-supervisor.cmd').toLowerCase();
  const entry = entryScript.toLowerCase();

  const psScript = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$runnerPs1 = ${psSingleQuote(runnerPs1)}`,
    `$runnerVbs = ${psSingleQuote(runnerVbs)}`,
    `$runnerCmd = ${psSingleQuote(runnerCmd)}`,
    `$entryScript = ${psSingleQuote(entry)}`,
    '$processCount = @(',
    '  Get-CimInstance Win32_Process | Where-Object {',
    '    $cmd = $_.CommandLine',
    '    if (-not $cmd) { return $false }',
    '    $cmdLower = $cmd.ToLowerInvariant()',
    '    if ($cmdLower.Contains($runnerPs1) -or $cmdLower.Contains($runnerVbs) -or $cmdLower.Contains($runnerCmd)) { return $true }',
    "    if ($entryScript -ne '' -and $cmdLower.Contains($entryScript) -and ($cmdLower -match '\\s+\"?(start|run)\"?(\\s|$)')) { return $true }",
    '    return $false',
    '  }',
    ').Count',
    `$task = Get-ScheduledTask -TaskName '${SERVICE_NAME}' -ErrorAction SilentlyContinue`,
    'if (-not $task) { [pscustomobject]@{ found = $false; processCount = [int]$processCount } | ConvertTo-Json -Compress; exit 0 }',
    `$info = Get-ScheduledTaskInfo -TaskName '${SERVICE_NAME}' -ErrorAction SilentlyContinue`,
    '[pscustomobject]@{',
    '  found = $true',
    '  state = [string]$task.State',
    '  lastRunTime = if ($info) { [string]$info.LastRunTime } else { "" }',
    '  nextRunTime = if ($info) { [string]$info.NextRunTime } else { "" }',
    '  lastTaskResult = if ($info) { [int]$info.LastTaskResult } else { 0 }',
    '  processCount = [int]$processCount',
    '} | ConvertTo-Json -Compress',
  ].join('\n');

  const result = await runCommand(
    ['powershell.exe', '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psScript],
    cwd,
  );

  if (result.code !== 0 || !result.stdout) {
    printKv('service.installed', 'unknown');
    printKv('service.state', 'unknown');
    if (result.stderr) printKv('service.error', result.stderr);
    return;
  }

  let parsed: WindowsTaskStatus | null = null;
  try {
    parsed = JSON.parse(result.stdout) as WindowsTaskStatus;
  } catch {
    parsed = null;
  }

  if (!parsed) {
    printKv('service.installed', 'unknown');
    printKv('service.state', 'unknown');
    printKv('service.raw', result.stdout);
    return;
  }

  if (!parsed.found) {
    printKv('service.installed', false);
    printKv('service.state', 'not-installed');
    printKv('service.runtimeRunning', (parsed.processCount ?? 0) > 0);
    printKv('service.processCount', parsed.processCount ?? 0);
    return;
  }

  printKv('service.installed', true);
  printKv('service.state', parsed.state ?? 'unknown');
  printKv('service.runtimeRunning', (parsed.processCount ?? 0) > 0);
  printKv('service.processCount', parsed.processCount ?? 0);
  if (parsed.lastRunTime) printKv('service.lastRunTime', parsed.lastRunTime);
  if (parsed.nextRunTime) printKv('service.nextRunTime', parsed.nextRunTime);
  if (parsed.lastTaskResult !== undefined) printKv('service.lastTaskResult', parsed.lastTaskResult);
}

async function printMacStatus(cwd: string, homeDir: string): Promise<void> {
  const plistPath = join(homeDir, 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`);
  printKv('service.plist', plistPath);
  printKv('service.plistStatus', safeStatSummary(plistPath));

  const result = await runCommand(['launchctl', 'list', SERVICE_LABEL], cwd);
  if (result.code === 0) {
    printKv('service.installed', true);
    printKv('service.state', 'loaded');
    if (result.stdout) printKv('service.launchctl', result.stdout.replace(/\s+/g, ' '));
    return;
  }

  printKv('service.installed', existsSync(plistPath));
  printKv('service.state', 'not-loaded');
  if (result.stderr) printKv('service.error', result.stderr);
}

async function printLinuxStatus(cwd: string, homeDir: string): Promise<void> {
  const unitName = `${SERVICE_NAME}.service`;
  const unitPath = join(homeDir, '.config', 'systemd', 'user', unitName);
  printKv('service.unit', unitPath);
  printKv('service.unitStatus', safeStatSummary(unitPath));

  const enabled = await runCommand(['systemctl', '--user', 'is-enabled', unitName], cwd);
  const active = await runCommand(['systemctl', '--user', 'is-active', unitName], cwd);

  printKv('service.installed', existsSync(unitPath));
  printKv('service.enabled', enabled.stdout || 'unknown');
  printKv('service.state', active.stdout || 'unknown');

  const err = [enabled.stderr, active.stderr].filter(Boolean).join(' | ');
  if (err) printKv('service.error', err);
}

export async function printServiceStatus(): Promise<void> {
  const cfg = loadConfig();
  const ctx = getServiceContext();
  const cfgPath = fileConfigPath(cfg.dataDir);
  const serviceDir = ctx.serviceDir;
  const serviceFiles = existsSync(serviceDir) ? readdirSync(serviceDir).sort() : [];
  const supervisorLog = join(serviceDir, 'supervisor.log');

  console.log('# sessions-ai status');
  printKv('platform', process.platform);
  printKv('serverUrl', cfg.serverUrl);
  printKv('dataDir', cfg.dataDir);
  printKv('configPath', cfgPath);

  printHeader('service');
  switch (process.platform) {
    case 'win32':
      await printWindowsStatus(ctx.launch.cwd, ctx.serviceDir, ctx.launch.args[0] ?? '');
      break;
    case 'darwin':
      await printMacStatus(ctx.launch.cwd, ctx.homeDir);
      break;
    default:
      await printLinuxStatus(ctx.launch.cwd, ctx.homeDir);
      break;
  }

  printHeader('artifacts');
  printKv('serviceDir', serviceDir);
  printKv('serviceDirStatus', safeStatSummary(serviceDir));
  printKv('serviceFiles', serviceFiles.length ? serviceFiles.join(', ') : '(none)');
  printKv('supervisorLog', supervisorLog);
  printKv('supervisorLogStatus', safeStatSummary(supervisorLog));
}
