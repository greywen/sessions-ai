import { describe, it, expect } from 'vitest';
import { hasRole, requireRole } from '../roles';

describe('Role Validation', () => {
  it('super_admin Should have all permissions', () => {
    expect(hasRole('super_admin', 'viewer')).toBe(true);
    expect(hasRole('super_admin', 'admin')).toBe(true);
    expect(hasRole('super_admin', 'super_admin')).toBe(true);
  });

  it('admin Should have viewer Permissions but no super_admin Permissions', () => {
    expect(hasRole('admin', 'viewer')).toBe(true);
    expect(hasRole('admin', 'admin')).toBe(true);
    expect(hasRole('admin', 'super_admin')).toBe(false);
  });

  it('viewer only viewer Permissions', () => {
    expect(hasRole('viewer', 'viewer')).toBe(true);
    expect(hasRole('viewer', 'admin')).toBe(false);
    expect(hasRole('viewer', 'super_admin')).toBe(false);
  });

  it('requireRole Exception should be thrown when permission is insufficient', () => {
    expect(() => requireRole('viewer', 'admin')).toThrow('Insufficient Permissions');
    expect(() => requireRole('admin', 'admin')).not.toThrow();
  });
});
