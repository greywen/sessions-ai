import { describe, it, expect } from 'vitest';
import { z } from 'zod';

// Recreate routes in schema
const createUserSchema = z.object({
  email: z.string().email('Invalid email format'),
  password: z.string().min(6, 'Password at least 6 bit'),
  name: z.string().optional(),
  role: z.enum(['super_admin', 'admin', 'viewer']).default('viewer'),
});

const patchUserSchema = z.object({
  role: z.enum(['super_admin', 'admin', 'viewer']).optional(),
  password: z.string().min(6, 'Password at least 6 bit').optional(),
  name: z.string().optional(),
}).refine((data) => data.role || data.password || data.name, {
  message: 'Specify at least one field to update',
});

describe('User Management API Schema Correction', () => {
  describe('POST /api/users Create User', () => {
    it('Legal parameters should be accepted', () => {
      const result = createUserSchema.safeParse({
        email: 'test@example.com',
        password: 'password123',
        role: 'admin',
      });
      expect(result.success).toBe(true);
      expect(result.data?.email).toBe('test@example.com');
      expect(result.data?.role).toBe('admin');
    });

    it('Default role should be used viewer', () => {
      const result = createUserSchema.safeParse({
        email: 'test@example.com',
        password: 'password123',
      });
      expect(result.success).toBe(true);
      expect(result.data?.role).toBe('viewer');
    });

    it('Invalid email should be rejected', () => {
      const result = createUserSchema.safeParse({
        email: 'not-an-email',
        password: 'password123',
      });
      expect(result.success).toBe(false);
    });

    it('Too short password should be rejected', () => {
      const result = createUserSchema.safeParse({
        email: 'test@example.com',
        password: '123',
      });
      expect(result.success).toBe(false);
    });

    it('Illegal roles should be rejected', () => {
      const result = createUserSchema.safeParse({
        email: 'test@example.com',
        password: 'password123',
        role: 'hacker',
      });
      expect(result.success).toBe(false);
    });

    it('should accept optional name', () => {
      const result = createUserSchema.safeParse({
        email: 'test@example.com',
        password: 'password123',
        name: 'Some test user',
      });
      expect(result.success).toBe(true);
      expect(result.data?.name).toBe('Some test user');
    });
  });

  describe('PATCH /api/users/[id] Update User', () => {
    it('Update role should be accepted', () => {
      const result = patchUserSchema.safeParse({ role: 'admin' });
      expect(result.success).toBe(true);
    });

    it('Password update should be accepted', () => {
      const result = patchUserSchema.safeParse({ password: 'newpass123' });
      expect(result.success).toBe(true);
    });

    it('Update name should be accepted', () => {
      const result = patchUserSchema.safeParse({ name: 'New name' });
      expect(result.success).toBe(true);
    });

    it('Empty updates should be rejected', () => {
      const result = patchUserSchema.safeParse({});
      expect(result.success).toBe(false);
    });

    it('Multiple fields should be accepted for simultaneous updates', () => {
      const result = patchUserSchema.safeParse({
        role: 'super_admin',
        name: 'Amministratore',
      });
      expect(result.success).toBe(true);
    });

    it('Too short password should be rejected', () => {
      const result = patchUserSchema.safeParse({ password: '123' });
      expect(result.success).toBe(false);
    });
  });
});
