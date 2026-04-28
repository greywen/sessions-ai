import { createHash } from 'node:crypto';
import { arch, hostname, platform, release, userInfo, cpus } from 'node:os';
import { machineIdSync } from 'node-machine-id';

export interface OsInfo {
  os: string;
  version: string;
  arch: string;
  hostname: string;
}

export interface FingerprintResult {
  /** SHA256 fingerprint (64-char hex). */
  fingerprint: string;
  osUsername: string;
  osInfo: OsInfo;
}

function platformName(): string {
  switch (platform()) {
    case 'win32':
      return 'Windows';
    case 'darwin':
      return 'macOS';
    case 'linux':
      return 'Linux';
    default:
      return platform();
  }
}

export async function generateFingerprint(): Promise<FingerprintResult> {
  const attrs: Array<[string, string]> = [];

  try {
    attrs.push(['machine_uid', machineIdSync(true)]);
  } catch {
    // machine-id is best-effort only
  }

  const cpuList = cpus();
  if (cpuList.length > 0) {
    attrs.push(['cpu_brand', cpuList[0]?.model ?? 'unknown']);
    attrs.push(['cpu_count', String(cpuList.length)]);
  }

  attrs.push(['hostname', hostname()]);
  attrs.push(['os_name', platformName()]);

  if (attrs.length === 0) {
    throw new Error('No stable fingerprint attributes available');
  }

  const hash = createHash('sha256');
  for (const [k, v] of attrs) {
    hash.update(`${k}=${v};`);
  }

  const osInfo: OsInfo = {
    os: platformName(),
    version: release(),
    arch: arch(),
    hostname: hostname(),
  };

  return {
    fingerprint: hash.digest('hex'),
    osUsername: userInfo().username,
    osInfo,
  };
}
