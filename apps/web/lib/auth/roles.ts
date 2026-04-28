import type { UserRole } from '@session-vault/shared';

const ROLE_HIERARCHY: Record<string, number> = {
  super_admin: 3,
  admin: 2,
  viewer: 1,
};

// Check that the user role meets the minimum required role
export function hasRole(userRole: string, requiredRole: UserRole): boolean {
  return (ROLE_HIERARCHY[userRole] ?? 0) >= (ROLE_HIERARCHY[requiredRole] ?? 0);
}

// On the server side API Role checksum used in
export function requireRole(userRole: string, requiredRole: UserRole): void {
  if (!hasRole(userRole, requiredRole)) {
    throw new Error(`Insufficient Permissions: Membutuhkan ${requiredRole} Role`);
  }
}
