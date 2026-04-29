ALTER TABLE "pricing_table" ADD COLUMN IF NOT EXISTS "sync_source" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "pricing_table" ADD COLUMN IF NOT EXISTS "sync_locked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "pricing_table" ADD COLUMN IF NOT EXISTS "last_synced_at" timestamp with time zone;--> statement-breakpoint
UPDATE "pricing_table"
SET "sync_source" = 'manual',
    "sync_locked" = true
WHERE "sync_source" = 'manual';
