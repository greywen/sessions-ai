ALTER TABLE "normalized_messages" ADD COLUMN IF NOT EXISTS "source_payload" jsonb;
--> statement-breakpoint
ALTER TABLE "favorite_snapshots" ADD COLUMN IF NOT EXISTS "source_payload" jsonb;
