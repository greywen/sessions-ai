import { describe, it, expect } from 'vitest';
import { z } from 'zod';

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const querySchema = z.object({
  from: dateStr,
  to: dateStr,
  groupBy: z.enum(['user', 'device', 'tool', 'model']).default('tool'),
});

describe('cost statistics API parameter check', () => {
  it('accepts valid yyyy-MM-dd from/to', () => {
    expect(querySchema.safeParse({ from: '2026-04-01', to: '2026-04-30' }).success).toBe(true);
  });
  it('rejects invalid date format', () => {
    expect(querySchema.safeParse({ from: '2026/04/01', to: '2026-04-30' }).success).toBe(false);
  });
  it('requires both from and to', () => {
    expect(querySchema.safeParse({ from: '2026-04-01' }).success).toBe(false);
  });
  it('groupBy defaults to tool', () => {
    expect(querySchema.parse({ from: '2026-04-01', to: '2026-04-30' }).groupBy).toBe('tool');
  });
  it('rejects invalid groupBy', () => {
    expect(querySchema.safeParse({ from: '2026-04-01', to: '2026-04-30', groupBy: 'project' }).success).toBe(false);
  });
});
