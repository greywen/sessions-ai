import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword } from '../password';

describe('Password Hash Tool', () => {
  it('Should be able to hash and validate passwords correctly', () => {
    const password = 'test-password-123';
    const hash = hashPassword(password);

    expect(hash).not.toBe(password);
    expect(verifyPassword(password, hash)).toBe(true);
  });

  it('Incorrect password should be rejected', () => {
    const hash = hashPassword('correct-password');
    expect(verifyPassword('wrong-password', hash)).toBe(false);
  });

  it('The same password should have a different hash value（Different salt values）', () => {
    const password = 'same-password';
    const hash1 = hashPassword(password);
    const hash2 = hashPassword(password);

    expect(hash1).not.toBe(hash2);
    expect(verifyPassword(password, hash1)).toBe(true);
    expect(verifyPassword(password, hash2)).toBe(true);
  });
});
