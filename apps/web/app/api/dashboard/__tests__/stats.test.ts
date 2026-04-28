import { describe, it, expect } from 'vitest';
import { z } from 'zod';

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const querySchema = z.object({
  from: dateStr,
  to: dateStr,
});

describe('Dashboard stats API schema validation', () => {
  it('accepts valid yyyy-MM-dd from/to', () => {
    expect(querySchema.safeParse({ from: '2026-04-01', to: '2026-04-30' }).success).toBe(true);
  });
  it('rejects missing parameters', () => {
    expect(querySchema.safeParse({}).success).toBe(false);
  });
  it('rejects malformed dates', () => {
    expect(querySchema.safeParse({ from: '2026-4-1', to: '2026-04-30' }).success).toBe(false);
  });
});

describe('MoM growth calculation', () => {
  const calcGrowth = (current: number, previous: number) => {
    if (previous === 0) return current > 0 ? 100 : 0;
    return Number((((current - previous) / previous) * 100).toFixed(1));
  };

  it('positive growth', () => {
    expect(calcGrowth(120, 100)).toBe(20);
  });
  it('negative growth', () => {
    expect(calcGrowth(80, 100)).toBe(-20);
  });
  it('previous zero, current positive returns 100', () => {
    expect(calcGrowth(50, 0)).toBe(100);
  });
  it('both zero returns 0', () => {
    expect(calcGrowth(0, 0)).toBe(0);
  });
  it('rounds to one decimal', () => {
    expect(calcGrowth(133, 100)).toBe(33);
    expect(calcGrowth(100, 3)).toBe(3233.3);
  });
});
