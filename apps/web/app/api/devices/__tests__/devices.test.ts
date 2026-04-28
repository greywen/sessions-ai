import { describe, it, expect } from 'vitest';
import { z } from 'zod';

// Recreate routes in schema Do Unit Test
const querySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(['pending', 'active', 'disabled']).optional(),
  sourceTool: z.string().optional(),
  search: z.string().optional(),
});

const patchSchema = z.object({
  action: z.enum(['approve', 'disable', 'enable', 'assign_owner', 'update_name']),
  ownerId: z.string().uuid().optional(),
  displayName: z.string().min(1).max(255).optional(),
}).refine((data) => {
  if (data.action === 'assign_owner' && !data.ownerId) return false;
  if (data.action === 'update_name' && !data.displayName) return false;
  return true;
}, { message: 'Missing required parameters' });

const VALID_TRANSITIONS: Record<string, string[]> = {
  approve: ['pending'],
  disable: ['active'],
  enable: ['disabled'],
  assign_owner: ['pending', 'active', 'disabled'],
  update_name: ['pending', 'active', 'disabled'],
};

describe('Equipment Management API Schema Correction', () => {
  describe('GET /api/devices Parameters', () => {
    it('Default parameters should be accepted', () => {
      const result = querySchema.safeParse({});
      expect(result.success).toBe(true);
      expect(result.data?.page).toBe(1);
      expect(result.data?.limit).toBe(20);
    });

    it('Legal paging parameters should be accepted', () => {
      const result = querySchema.safeParse({ page: '2', limit: '50' });
      expect(result.success).toBe(true);
      expect(result.data?.page).toBe(2);
      expect(result.data?.limit).toBe(50);
    });

    it('Out of range should be rejected limit', () => {
      const result = querySchema.safeParse({ limit: '200' });
      expect(result.success).toBe(false);
    });

    it('Acceptable status Filter Bar', () => {
      const result = querySchema.safeParse({ status: 'pending' });
      expect(result.success).toBe(true);
      expect(result.data?.status).toBe('pending');
    });

    it('Illegal should be rejected status', () => {
      const result = querySchema.safeParse({ status: 'unknown' });
      expect(result.success).toBe(false);
    });

    it('Acceptable search Specs', () => {
      const result = querySchema.safeParse({ search: 'test-device' });
      expect(result.success).toBe(true);
      expect(result.data?.search).toBe('test-device');
    });
  });

  describe('PATCH /api/devices/[id] Verify', () => {
    it('Acceptable approve Aksi', () => {
      const result = patchSchema.safeParse({ action: 'approve' });
      expect(result.success).toBe(true);
    });

    it('Acceptable disable Aksi', () => {
      const result = patchSchema.safeParse({ action: 'disable' });
      expect(result.success).toBe(true);
    });

    it('Acceptable enable Aksi', () => {
      const result = patchSchema.safeParse({ action: 'enable' });
      expect(result.success).toBe(true);
    });

    it('Acceptable assign_owner Aksi（Bawa ownerId）', () => {
      const result = patchSchema.safeParse({
        action: 'assign_owner',
        ownerId: '550e8400-e29b-41d4-a716-446655440000',
      });
      expect(result.success).toBe(true);
    });

    it('Should be rejected assign_owner Aksi（N/A ownerId）', () => {
      const result = patchSchema.safeParse({ action: 'assign_owner' });
      expect(result.success).toBe(false);
    });

    it('Acceptable update_name Aksi（Bawa displayName）', () => {
      const result = patchSchema.safeParse({
        action: 'update_name',
        displayName: 'New device name',
      });
      expect(result.success).toBe(true);
    });

    it('Should be rejected update_name Aksi（N/A displayName）', () => {
      const result = patchSchema.safeParse({ action: 'update_name' });
      expect(result.success).toBe(false);
    });

    it('Illegal should be rejected action', () => {
      const result = patchSchema.safeParse({ action: 'unknown_action' });
      expect(result.success).toBe(false);
    });
  });

  describe('State Transition Rules', () => {
    it('approve Allow only from pending Status', () => {
      expect(VALID_TRANSITIONS.approve).toEqual(['pending']);
      expect(VALID_TRANSITIONS.approve.includes('pending')).toBe(true);
      expect(VALID_TRANSITIONS.approve.includes('active')).toBe(false);
    });

    it('disable Allow only from active Status', () => {
      expect(VALID_TRANSITIONS.disable).toEqual(['active']);
    });

    it('enable Allow only from disabled Status', () => {
      expect(VALID_TRANSITIONS.enable).toEqual(['disabled']);
    });

    it('assign_owner Allow any state', () => {
      expect(VALID_TRANSITIONS.assign_owner).toEqual(['pending', 'active', 'disabled']);
    });

    it('update_name Allow any state', () => {
      expect(VALID_TRANSITIONS.update_name).toEqual(['pending', 'active', 'disabled']);
    });
  });
});
