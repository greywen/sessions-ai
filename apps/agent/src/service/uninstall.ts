import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { SERVICE_LABEL, SERVICE_NAME, getServiceContext } from './shared.ts';

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

async function uninstallWindows(cwd: string): Promise<void> {
  await runCommand(['schtasks', '/End', '/TN', SERVICE_NAME], cwd).catch(() => undefined);
  await runCommand(['schtasks', '/Delete', '/TN', SERVICE_NAME, '/F'], cwd).catch(() => undefined);
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

export async function uninstallService(): Promise<void> {
  const ctx = getServiceContext();
  const plistPath = join(ctx.homeDir, 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`);
  const unitPath = join(ctx.homeDir, '.config', 'systemd', 'user', `${SERVICE_NAME}.service`);

  switch (process.platform) {
    case 'win32':
      await uninstallWindows(ctx.launch.cwd);
      break;
    case 'darwin':
      await uninstallMac(plistPath, ctx.launch.cwd);
      break;
    default:
      await uninstallLinux(unitPath, ctx.launch.cwd);
      break;
  }

  rmSync(ctx.serviceDir, { recursive: true, force: true });
  console.log(`Removed ${SERVICE_NAME} and cleaned ${ctx.serviceDir}`);
}
