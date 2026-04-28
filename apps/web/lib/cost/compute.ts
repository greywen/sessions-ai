/**
 * 单条消息的 USD 成本计算（TypeScript 端）。
 *
 * 与历史 SQL 实现（`pricingJoinForNm` + `costExpr`）等价，但搬到写入侧物化到
 * `normalized_messages.cost_usd`，读侧不再 JOIN pricing_table。
 *
 * 模型名匹配优先级（与原 LATERAL JOIN 完全等价）：
 *   1. raw                — 去掉前导 `~` 的原始 model 名
 *   2. strip_first        — 去掉第一段 `provider/`
 *   3. strip_last         — 只保留路径最后一段
 *   4. strip_first_hyphen — strip_first 的点替换为 -
 *   5. strip_last_hyphen  — strip_last 的点替换为 -
 *
 * 时间窗口：`pricing_table.effective_from <= rawTimestamp <= effective_to`
 * （`effective_to IS NULL` 视为永久有效）。
 */

import { inArray } from 'drizzle-orm';
import type { db as DbType } from '@/lib/db';
import { pricingTable } from '@/lib/db/schema';

export interface UsageJson {
  inputTokens?: number | string | null;
  outputTokens?: number | string | null;
  cacheCreationInputTokens?: number | string | null;
  cacheReadInputTokens?: number | string | null;
  model?: string | null;
}

export interface PricingRow {
  id: string;
  model: string;
  inputPricePerMtok: string; // numeric stored as string
  outputPricePerMtok: string;
  cachePricePerMtok: string | null;
  effectiveFrom: string; // 'YYYY-MM-DD'
  effectiveTo: string | null;
}

export interface CostResult {
  costUsd: string; // numeric stringified, e.g. '0.001234'
  pricingId: string | null;
}

const ZERO: CostResult = { costUsd: '0', pricingId: null };

/** Normalized model name candidates in matching priority order (deduped). */
export function modelCandidates(model: string | null | undefined): string[] {
  const raw = (model ?? '').replace(/^~/, '');
  if (!raw) return [];
  const stripFirst = raw.replace(/^[^/]+\//, '');
  const stripLast = raw.replace(/^.*\//, '');
  const stripFirstHyphen = stripFirst.replace(/\./g, '-');
  const stripLastHyphen = stripLast.replace(/\./g, '-');
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of [raw, stripFirst, stripLast, stripFirstHyphen, stripLastHyphen]) {
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

/** YYYY-MM-DD slice from a Date. */
function dateOnly(ts: Date): string {
  const y = ts.getUTCFullYear();
  const m = String(ts.getUTCMonth() + 1).padStart(2, '0');
  const d = String(ts.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Pick the best matching pricing row for a given model + timestamp.
 *
 * Order of preference:
 *   1. earlier candidate index wins (raw > stripFirst > ...)
 *   2. tie-broken by `effective_from DESC` (more recent rate)
 */
export function pickPricing(
  candidates: string[],
  ts: Date,
  pricings: PricingRow[],
): PricingRow | null {
  if (candidates.length === 0 || pricings.length === 0) return null;
  const day = dateOnly(ts);
  const candIndex = new Map<string, number>();
  candidates.forEach((c, i) => candIndex.set(c, i));

  let best: PricingRow | null = null;
  let bestRank = Infinity;
  let bestEffective = '';
  for (const p of pricings) {
    const rank = candIndex.get(p.model);
    if (rank === undefined) continue;
    if (p.effectiveFrom > day) continue;
    if (p.effectiveTo != null && p.effectiveTo < day) continue;
    if (
      rank < bestRank ||
      (rank === bestRank && p.effectiveFrom > bestEffective)
    ) {
      best = p;
      bestRank = rank;
      bestEffective = p.effectiveFrom;
    }
  }
  return best;
}

/** Compute cost for a single message given its usage and the chosen pricing row. */
export function computeCost(usage: UsageJson | null, pricing: PricingRow | null): CostResult {
  if (!usage || !pricing) return ZERO;
  const inTok = toNumber(usage.inputTokens);
  const outTok = toNumber(usage.outputTokens);
  const cacheCreate = toNumber(usage.cacheCreationInputTokens);
  const cacheRead = toNumber(usage.cacheReadInputTokens);
  const inPrice = toNumber(pricing.inputPricePerMtok);
  const outPrice = toNumber(pricing.outputPricePerMtok);
  const cachePrice = toNumber(pricing.cachePricePerMtok);

  const cost =
    (inTok / 1_000_000) * inPrice +
    (outTok / 1_000_000) * outPrice +
    ((cacheCreate + cacheRead) / 1_000_000) * cachePrice;

  if (!Number.isFinite(cost) || cost <= 0) {
    return { costUsd: '0', pricingId: pricing.id };
  }
  // numeric(12,6) — keep 6 fractional digits
  return { costUsd: cost.toFixed(6), pricingId: pricing.id };
}

/**
 * Batch-load all pricing rows that could match any of the given models within
 * any of the given timestamps. Loads the minimal set required for one ingest
 * batch — typically a handful of rows total.
 *
 * Strategy: for each timestamp's candidate set we'd need a separate query, but
 * batches share models and timestamps cluster within a day. We just collect
 * the union of all candidate model names and pull every pricing row whose
 * `model` is in that union; date filtering happens client-side in pickPricing.
 */
export async function loadPricingForBatch(
  database: typeof DbType,
  items: Array<{ usage: UsageJson | null }>,
): Promise<PricingRow[]> {
  const allCandidates = new Set<string>();
  for (const it of items) {
    const m = it.usage?.model;
    if (typeof m === 'string') {
      for (const c of modelCandidates(m)) allCandidates.add(c);
    }
  }
  if (allCandidates.size === 0) return [];

  const rows = await database
    .select({
      id: pricingTable.id,
      model: pricingTable.model,
      inputPricePerMtok: pricingTable.inputPricePerMtok,
      outputPricePerMtok: pricingTable.outputPricePerMtok,
      cachePricePerMtok: pricingTable.cachePricePerMtok,
      effectiveFrom: pricingTable.effectiveFrom,
      effectiveTo: pricingTable.effectiveTo,
    })
    .from(pricingTable)
    .where(inArray(pricingTable.model, [...allCandidates]));
  return rows as PricingRow[];
}

/**
 * Convenience wrapper: compute cost for one message synchronously given a
 * pre-loaded pricing pool. Returns ZERO if usage is null or no pricing matches.
 */
export function computeCostFor(
  usage: UsageJson | null,
  rawTimestamp: Date,
  pricings: PricingRow[],
): CostResult {
  if (!usage || typeof usage.model !== 'string') return ZERO;
  const cands = modelCandidates(usage.model);
  if (cands.length === 0) return ZERO;
  const picked = pickPricing(cands, rawTimestamp, pricings);
  return computeCost(usage, picked);
}
