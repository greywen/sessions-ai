import { describe, it, expect } from 'vitest';
import { z } from 'zod';

// Recreate routes in schema
const createPricingSchema = z.object({
  model: z.string().min(1, 'Model ID cannot be empty'),
  inputPricePerMillion: z.number().min(0),
  outputPricePerMillion: z.number().min(0),
  cachePricePerMillion: z.number().min(0).default(0),
});

const patchPricingSchema = z.object({
  model: z.string().min(1).optional(),
  inputPricePerMillion: z.number().min(0).optional(),
  outputPricePerMillion: z.number().min(0).optional(),
  cachePricePerMillion: z.number().min(0).optional(),
});

describe('Pricing Table API Schema Correction', () => {
  describe('POST /api/pricing Create a price', () => {
    it('Legal parameters should be accepted', () => {
      const result = createPricingSchema.safeParse({
        model: 'claude-sonnet-4-6',
        inputPricePerMillion: 3.0,
        outputPricePerMillion: 15.0,
        cachePricePerMillion: 0.3,
      });
      expect(result.success).toBe(true);
      expect(result.data?.model).toBe('claude-sonnet-4-6');
    });

    it('Default should be used cachePricePerMillion', () => {
      const result = createPricingSchema.safeParse({
        model: 'gpt-4',
        inputPricePerMillion: 30.0,
        outputPricePerMillion: 60.0,
      });
      expect(result.success).toBe(true);
      expect(result.data?.cachePricePerMillion).toBe(0);
    });

    it('Empty model name should be rejected', () => {
      const result = createPricingSchema.safeParse({
        model: '',
        inputPricePerMillion: 3.0,
        outputPricePerMillion: 15.0,
      });
      expect(result.success).toBe(false);
    });

    it('Negative price should be rejected', () => {
      const result = createPricingSchema.safeParse({
        model: 'gpt-4',
        inputPricePerMillion: -1,
        outputPricePerMillion: 15.0,
      });
      expect(result.success).toBe(false);
    });
  });

  describe('PATCH /api/pricing/[id] Update price', () => {
    it('Some updates should be accepted', () => {
      const result = patchPricingSchema.safeParse({
        inputPricePerMillion: 5.0,
      });
      expect(result.success).toBe(true);
    });

    it('Empty object should be accepted', () => {
      const result = patchPricingSchema.safeParse({});
      expect(result.success).toBe(true);
    });
  });
});
