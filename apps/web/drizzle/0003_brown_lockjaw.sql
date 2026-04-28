ALTER TABLE "normalized_messages" ADD COLUMN "cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "normalized_messages" ADD COLUMN "pricing_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_pricing_model_unique" ON "pricing_table" USING btree ("model");