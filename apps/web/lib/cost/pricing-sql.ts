import { sql } from 'drizzle-orm';

// 仅保留模型名归一化片段，供读侧 GROUP BY 显示用。
// 计费 JOIN 已被 normalized_messages.cost_usd 物化列替代（lib/cost/compute.ts）。
export const nmUsageModelRawExpr = sql`REGEXP_REPLACE(COALESCE(nm.usage->>'model', ''), '^~', '')`;
export const nmUsageModelStripFirstExpr = sql`REGEXP_REPLACE(${nmUsageModelRawExpr}, '^[^/]+/', '')`;
export const nmUsageModelStripLastExpr = sql`REGEXP_REPLACE(${nmUsageModelRawExpr}, '^.*/', '')`;
