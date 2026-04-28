import { describe, it, expect } from 'vitest';
import { z } from 'zod';

// Session List Query Parameters schema(AND: route.ts Synchronous)
const querySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sourceTool: z.string().optional(),
  machineId: z.string().uuid().optional(),
  userId: z.string().uuid().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  search: z.string().max(200).optional(),
  favorite: z.enum(['true', 'false']).optional(),
});

// Message Paging Query Parameters schema
const messagesQuerySchema = z.object({
  cursor: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  favorite: z.enum(['true', 'false']).optional(),
});

describe('Sessions API Schema Correction', () => {
  describe('Session List Parameters', () => {
    it('Default parameters should be accepted', () => {
      const result = querySchema.safeParse({});
      expect(result.success).toBe(true);
      expect(result.data?.page).toBe(1);
      expect(result.data?.limit).toBe(20);
    });

    it('Full parameters should be accepted', () => {
      const result = querySchema.safeParse({
        page: 2,
        limit: 50,
        sourceTool: 'ClaudeCode',
        machineId: '550e8400-e29b-41d4-a716-446655440000',
        from: '2026-04-01T00:00:00Z',
        to: '2026-04-30T23:59:59Z',
      });
      expect(result.success).toBe(true);
      expect(result.data?.page).toBe(2);
      expect(result.data?.sourceTool).toBe('ClaudeCode');
    });

    it('Acceptable userId Filter Bar', () => {
      const result = querySchema.safeParse({
        userId: '550e8400-e29b-41d4-a716-446655440000',
      });
      expect(result.success).toBe(true);
      expect(result.data?.userId).toBe('550e8400-e29b-41d4-a716-446655440000');
    });

    it('Acceptable search Specs', () => {
      const result = querySchema.safeParse({
        search: 'Help me fix it auth.ts',
      });
      expect(result.success).toBe(true);
      expect(result.data?.search).toBe('Help me fix it auth.ts');
    });

    it('Acceptable favorite Filter Bar', () => {
      const result = querySchema.safeParse({
        favorite: 'true',
      });
      expect(result.success).toBe(true);
      expect(result.data?.favorite).toBe('true');
    });

    it('Excessive length should be rejected search', () => {
      const result = querySchema.safeParse({
        search: 'a'.repeat(201),
      });
      expect(result.success).toBe(false);
    });

    it('Invalid should be rejected page', () => {
      const result = querySchema.safeParse({ page: 0 });
      expect(result.success).toBe(false);
    });

    it('Out-of-scope should be rejected limit', () => {
      const result = querySchema.safeParse({ limit: 200 });
      expect(result.success).toBe(false);
    });

    it('Invalid should be rejected UUID', () => {
      const result = querySchema.safeParse({ machineId: 'not-a-uuid' });
      expect(result.success).toBe(false);
    });

    it('String numbers should be automatically converted', () => {
      const result = querySchema.safeParse({ page: '3', limit: '25' });
      expect(result.success).toBe(true);
      expect(result.data?.page).toBe(3);
      expect(result.data?.limit).toBe(25);
    });
  });

  describe('Message Pagination Parameters', () => {
    it('Default parameters should be accepted', () => {
      const result = messagesQuerySchema.safeParse({});
      expect(result.success).toBe(true);
      expect(result.data?.limit).toBe(50);
      expect(result.data?.cursor).toBeUndefined();
    });

    it('should accept valid cursor', () => {
      const result = messagesQuerySchema.safeParse({
        cursor: '2026-04-03T10:00:00Z',
        limit: 30,
        favorite: 'false',
      });
      expect(result.success).toBe(true);
      expect(result.data?.cursor).toBe('2026-04-03T10:00:00Z');
      expect(result.data?.favorite).toBe('false');
    });

    it('Invalid date format should be rejected cursor', () => {
      const result = messagesQuerySchema.safeParse({
        cursor: 'not-a-date',
      });
      expect(result.success).toBe(false);
    });

    it('Out-of-scope should be rejected limit', () => {
      const result = messagesQuerySchema.safeParse({ limit: 150 });
      expect(result.success).toBe(false);
    });
  });

  describe('Paging Response Format', () => {
    it('The total number of pages should be calculated correctly', () => {
      const total = 45;
      const limit = 20;
      const totalPages = Math.ceil(total / limit);
      expect(totalPages).toBe(3);
    });

    it('out of total 0 when the number of pages is 0', () => {
      const total = 0;
      const limit = 20;
      const totalPages = Math.ceil(total / limit);
      expect(totalPages).toBe(0);
    });

    it('Precise number of pages when exactly divided by', () => {
      const total = 40;
      const limit = 20;
      const totalPages = Math.ceil(total / limit);
      expect(totalPages).toBe(2);
    });
  });
});
