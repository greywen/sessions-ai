import { describe, expect, it } from 'vitest';
import { computeCostFor, modelCandidates, type PricingRow } from '../compute';

describe('cost compute model matching', () => {
  it('matches OpenCode routing suffix models to the base pricing row', () => {
    expect(modelCandidates('gpt-5.5-1')).toContain('gpt-5.5');

    const pricing: PricingRow = {
      id: 'pricing-gpt-55',
      model: 'gpt-5.5',
      inputPricePerMtok: '5.0000',
      outputPricePerMtok: '30.0000',
      cachePricePerMtok: '0.5000',
      effectiveFrom: '2026-04-01',
      effectiveTo: null,
    };

    const result = computeCostFor(
      {
        model: 'gpt-5.5-1',
        inputTokens: 5238,
        outputTokens: 313,
        cacheCreationInputTokens: null,
        cacheReadInputTokens: null,
      },
      new Date('2026-04-27T01:42:48.290Z'),
      [pricing],
    );

    expect(result.pricingId).toBe('pricing-gpt-55');
    expect(result.costUsd).toBe('0.035580');
  });
});
