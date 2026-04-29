-- 物化每条消息的 USD 成本（cost_usd）+ 引用使用的 pricing_table 行（pricing_id）。
-- 写入时根据当时有效的 pricing 行算好定价，读侧 SUM(cost_usd) 即可，
-- 不再需要在每个统计查询里 JOIN pricing_table。
ALTER TABLE "normalized_messages" ADD COLUMN IF NOT EXISTS "cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "normalized_messages" ADD COLUMN IF NOT EXISTS "pricing_id" uuid;
