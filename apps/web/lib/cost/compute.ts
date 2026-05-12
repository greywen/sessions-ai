/**
 * Compute per-message USD cost from token usage with fixed environment prices.
 *
 * Pricing-table-based dynamic matching has been removed. If no environment
 * prices are configured, costs default to zero.
 */

export interface UsageJson {
  inputTokens?: number | string | null;
  outputTokens?: number | string | null;
  cacheCreationInputTokens?: number | string | null;
  cacheReadInputTokens?: number | string | null;
  model?: string | null;
}

export interface CostResult {
  costUsd: string;
}

const ZERO: CostResult = { costUsd: '0' };

const INPUT_PRICE_PER_MTOK = parsePrice(process.env.COST_INPUT_PRICE_PER_MTOK);
const OUTPUT_PRICE_PER_MTOK = parsePrice(process.env.COST_OUTPUT_PRICE_PER_MTOK);
const CACHE_PRICE_PER_MTOK = parsePrice(process.env.COST_CACHE_PRICE_PER_MTOK);

function parsePrice(raw: string | undefined): number {
  if (!raw) return 0;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
}

function stripRoutingSuffix(candidate: string): string {
  return /\.\d/.test(candidate) ? candidate.replace(/-[1-9]$/, '') : candidate;
}

/** Normalized model name candidates in matching priority order (deduped). */
export function modelCandidates(model: string | null | undefined): string[] {
  const raw = (model ?? '').replace(/^~/, '');
  if (!raw) return [];
  const stripFirst = raw.replace(/^[^/]+\//, '');
  const stripLast = raw.replace(/^.*\//, '');
  const stripFirstRouteBase = stripRoutingSuffix(stripFirst);
  const stripLastRouteBase = stripRoutingSuffix(stripLast);
  const stripFirstHyphen = stripFirst.replace(/\./g, '-');
  const stripLastHyphen = stripLast.replace(/\./g, '-');
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of [
    raw,
    stripFirst,
    stripLast,
    stripFirstRouteBase,
    stripLastRouteBase,
    stripFirstHyphen,
    stripLastHyphen,
  ]) {
    if (c && !seen.has(c)) {
      seen.add(c);
      out.push(c);
    }
  }
  return out;
}

function toNumber(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/** Compute cost for a single message from token usage and static env prices. */
export function computeCost(usage: UsageJson | null): CostResult {
  if (!usage) return ZERO;
  const inTok = toNumber(usage.inputTokens);
  const outTok = toNumber(usage.outputTokens);
  const cacheCreate = toNumber(usage.cacheCreationInputTokens);
  const cacheRead = toNumber(usage.cacheReadInputTokens);
  const inPrice = INPUT_PRICE_PER_MTOK;
  const outPrice = OUTPUT_PRICE_PER_MTOK;
  const cachePrice = CACHE_PRICE_PER_MTOK;

  const cost =
    (inTok / 1_000_000) * inPrice +
    (outTok / 1_000_000) * outPrice +
    ((cacheCreate + cacheRead) / 1_000_000) * cachePrice;

  if (!Number.isFinite(cost) || cost <= 0) {
    return { costUsd: '0' };
  }
  return { costUsd: cost.toFixed(6) };
}

export async function loadPricingForBatch(
  _database: unknown,
  _items: Array<{ usage: UsageJson | null }>,
): Promise<[]> {
  return [];
}

// Keep the legacy signature to avoid touching all call sites at once.
export function computeCostFor(
  usage: UsageJson | null,
  _rawTimestamp: Date,
  _pricings: unknown[],
): CostResult {
  return computeCost(usage);
}
