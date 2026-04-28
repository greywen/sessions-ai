import { chmodSync } from 'node:fs';
import { join } from 'node:path';

import {
  APP_ROOT,
  SERVICE_LABEL,
  SERVICE_NAME,
  SUPERVISOR_ENTRYPOINT,
  type ServiceContext,
  getServiceContext,
  shEscape,
  systemdEscape,
  toPosixPath,
  windowsCmdEscape,
  writeTextFile,
  xmlEscape,
} from './shared.ts';

const args = new Set(Bun.argv.slice(2));
const printOnly = args.has('--print');
const noStart = args.has('--no-start');

function logStep(message: string, details?: string): void {
  console.log(details ? `${message}\n${details}` : message);
}

async function runCommand(command: string[], cwd = APP_ROOT): Promise<void> {
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

function buildWindowsRunner(ctx: ServiceContext): string {
  const logPath = join(ctx.serviceDir, 'supervisor.log');
  return [
    '@echo off',
    'chcp 65001 >nul',
    `cd /d ${windowsCmdEscape(ctx.appRoot)}`,
    `${windowsCmdEscape(ctx.bunPath)} ${windowsCmdEscape(SUPERVISOR_ENTRYPOINT)} >> ${windowsCmdEscape(logPath)} 2>&1`,
  ].join('\r\n');
}

async function installWindows(ctx: ServiceContext): Promise<void> {
  const runnerPath = join(ctx.serviceDir, 'run-supervisor.cmd');
  writeTextFile(runnerPath, `${buildWindowsRunner(ctx)}\r\n`);

  if (printOnly) {
    logStep('Windows Task Scheduler wrapper preview:', runnerPath);
    logStep(buildWindowsRunner(ctx));
    return;
  }

  await runCommand([
    'schtasks',
    '/Create',
    '/TN',
    SERVICE_NAME,
    '/SC',
    'ONLOGON',
    '/F',
    '/TR',
    windowsCmdEscape(runnerPath),
  ]);

  if (!noStart) {
    await runCommand(['schtasks', '/Run', '/TN', SERVICE_NAME]);
  }

  logStep(
    'Windows persistent task installed.',
    `Task: ${SERVICE_NAME}\nWrapper: ${runnerPath}\nLog: ${join(ctx.serviceDir, 'supervisor.log')}`,
  );
}

function buildLaunchAgent(ctx: ServiceContext): string {
  const stdoutPath = xmlEscape(join(ctx.serviceDir, 'stdout.log'));
  const stderrPath = xmlEscape(join(ctx.serviceDir, 'stderr.log'));
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${SERVICE_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${xmlEscape(ctx.bunPath)}</string>
      <string>${xmlEscape(SUPERVISOR_ENTRYPOINT)}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${xmlEscape(ctx.appRoot)}</string>
    <key>EnvironmentVariables</key>
    <dict>
      <key>PATH</key>
      <string>${xmlEscape(ctx.pathEnv)}</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${stdoutPath}</string>
    <key>StandardErrorPath</key>
    <string>${stderrPath}</string>
  </dict>
</plist>
`;
}

async function installMac(ctx: ServiceContext): Promise<void> {
  const plistPath = join(ctx.homeDir, 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`);
  const content = buildLaunchAgent(ctx);
  writeTextFile(plistPath, content);

  if (printOnly) {
    logStep('macOS launchd plist preview:', plistPath);
    logStep(content);
    return;
  }

  await runCommand(['launchctl', 'unload', plistPath]).catch(() => undefined);
  await runCommand(['launchctl', 'load', '-w', plistPath]);

  logStep(
    'macOS LaunchAgent installed.',
    `plist: ${plistPath}\nstdout: ${join(ctx.serviceDir, 'stdout.log')}\nstderr: ${join(ctx.serviceDir, 'stderr.log')}`,
  );
}

function buildLinuxRunner(ctx: ServiceContext): string {
  return [
    '#!/usr/bin/env sh',
    'set -eu',
    `cd ${shEscape(ctx.appRoot)}`,
    `exec ${shEscape(ctx.bunPath)} ${shEscape(SUPERVISOR_ENTRYPOINT)}`,
  ].join('\n');
}

function buildSystemdUnit(ctx: ServiceContext, runnerPath: string): string {
  return `[Unit]
Description=llm-sessions Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${systemdEscape(ctx.appRoot)}
ExecStart=${systemdEscape(runnerPath)}
Restart=always
RestartSec=5
Environment=PATH=${systemdEscape(ctx.pathEnv)}

[Install]
WantedBy=default.target
`;
}

async function installLinux(ctx: ServiceContext): Promise<void> {
  const runnerPath = join(ctx.serviceDir, 'run-supervisor.sh');
  const runnerContent = buildLinuxRunner(ctx);
  writeTextFile(runnerPath, `${runnerContent}\n`);
  chmodSync(runnerPath, 0o755);

  const unitPath = join(ctx.homeDir, '.config', 'systemd', 'user', `${SERVICE_NAME}.service`);
  const unitContent = buildSystemdUnit(ctx, runnerPath);
  writeTextFile(unitPath, unitContent);

  if (printOnly) {
    logStep('Linux systemd user service preview:', unitPath);
    logStep(unitContent);
    return;
  }

  await runCommand(['systemctl', '--user', 'daemon-reload']);
  await runCommand(['systemctl', '--user', 'enable', '--now', `${SERVICE_NAME}.service`]);

  logStep(
    'Linux systemd user service installed.',
    `unit: ${unitPath}\nrunner: ${runnerPath}\nTo keep running after logout, run: loginctl enable-linger ${process.env.USER ?? '$USER'}`,
  );
}

async function main(): Promise<void> {
  const ctx = getServiceContext();
  logStep('Preparing to install persistent Agent service.', `Platform: ${process.platform}\nWorking directory: ${toPosixPath(ctx.appRoot)}`);

  switch (process.platform) {
    case 'win32':
      await installWindows(ctx);
      return;
    case 'darwin':
      await installMac(ctx);
      return;
    default:
      await installLinux(ctx);
  }
}

main().catch((error) => {
  console.error('Service installation failed:', error);
  process.exit(1);
});
