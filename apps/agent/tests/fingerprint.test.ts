import { describe, expect, test } from 'bun:test';
import { generateFingerprint } from '../src/identity/fingerprint.ts';

describe('fingerprint', () => {
  test('returns stable SHA256 fingerprint', async () => {
    const a = await generateFingerprint();
    const b = await generateFingerprint();
    expect(a.fingerprint).toHaveLength(64); // sha256 hex
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.osUsername.length).toBeGreaterThan(0);
    expect(a.osInfo.os.length).toBeGreaterThan(0);
    expect(a.osInfo.arch.length).toBeGreaterThan(0);
    expect(a.osInfo.hostname.length).toBeGreaterThan(0);
  });
});
