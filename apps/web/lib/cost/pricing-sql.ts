import { sql } from 'drizzle-orm';

// Keep only normalized model-name SQL snippets for read-side GROUP BY display.
// Billing JOINs are replaced by the materialized normalized_messages.cost_usd column (lib/cost/compute.ts).
export const nmUsageModelRawExpr = sql`REGEXP_REPLACE(COALESCE(nm.usage->>'model', ''), '^~', '')`;
export const nmUsageModelStripFirstExpr = sql`REGEXP_REPLACE(${nmUsageModelRawExpr}, '^[^/]+/', '')`;
export const nmUsageModelStripLastExpr = sql`REGEXP_REPLACE(${nmUsageModelRawExpr}, '^.*/', '')`;