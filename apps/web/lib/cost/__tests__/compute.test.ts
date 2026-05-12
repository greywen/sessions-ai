import { describe, expect, it } from 'vitest';
import { computeCostFor, modelCandidates } from '../compute';

describe('cost compute model matching', () => {
  it('normalizes routed model ids', () => {
    expect(modelCandidates('gpt-5.5-1')).toContain('gpt-5.5');
  });

  it('returns zero when no static token prices are configured', () => {
    const result = computeCostFor(
      {
        model: 'gpt-5.5-1',
        inputTokens: 5238,
        outputTokens: 313,
        cacheCreationInputTokens: null,
        cacheReadInputTokens: null,
      },
      new Date('2026-04-27T01:42:48.290Z'),
      [],
    );

    expect(result.costUsd).toBe('0');
  });
});
