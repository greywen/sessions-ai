import { describe, it, expect } from 'vitest';
import { signToken, verifyToken } from '../jwt';

describe('JWT Tool Functions', () => {
  it('Should be able to issue and verify validity token', async () => {
    const payload = { userId: 'test-id', email: 'test@example.com', role: 'admin' };
    const token = await signToken(payload);

    expect(token).toBeTruthy();
    expect(typeof token).toBe('string');

    const verified = await verifyToken(token);
    expect(verified).not.toBeNull();
    expect(verified?.userId).toBe('test-id');
    expect(verified?.email).toBe('test@example.com');
    expect(verified?.role).toBe('admin');
  });

  it('Invalid should be rejected token', async () => {
    const result = await verifyToken('invalid-token');
    expect(result).toBeNull();
  });

  it('Should refuse to be tampered with token', async () => {
    const payload = { userId: 'test-id', email: 'test@example.com', role: 'admin' };
    const token = await signToken(payload);

    // Tamper payload PART
    const parts = token.split('.');
    parts[1] = parts[1] + 'tampered';
    const tamperedToken = parts.join('.');

    const result = await verifyToken(tamperedToken);
    expect(result).toBeNull();
  });
});
