-- Session-level favorite (just bookmarks the session by id; the underlying
-- normalized_messages remain the source of truth for content).
CREATE TABLE IF NOT EXISTS "session_favorites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- Message-level favorite stores a FROZEN COPY of the UnifiedMessage payload
-- so the user can come back to it years later, even after parsers are
-- rewritten or the source row is purged. No FK to normalized_messages on
-- purpose: the snapshot must outlive the source.
CREATE TABLE IF NOT EXISTS "favorite_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"source_message_id" uuid NOT NULL,
	"source_session_id" text NOT NULL,
	"source_tool" text NOT NULL,
	"machine_id" uuid NOT NULL,
	"role" text NOT NULL,
	"content_blocks" jsonb NOT NULL,
	"usage" jsonb,
	"metadata" jsonb,
	"raw_timestamp" timestamp with time zone NOT NULL,
	"user_note" text,
	"snapshotted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'session_favorites_user_id_users_id_fk'
	) THEN
		ALTER TABLE "session_favorites" ADD CONSTRAINT "session_favorites_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'favorite_snapshots_user_id_users_id_fk'
	) THEN
		ALTER TABLE "favorite_snapshots" ADD CONSTRAINT "favorite_snapshots_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_session_favorites_unique" ON "session_favorites" USING btree ("user_id","session_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_session_favorites_user" ON "session_favorites" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_session_favorites_session" ON "session_favorites" USING btree ("session_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_favorite_snapshots_unique" ON "favorite_snapshots" USING btree ("user_id","source_message_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_favorite_snapshots_user" ON "favorite_snapshots" USING btree ("user_id","snapshotted_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_favorite_snapshots_session" ON "favorite_snapshots" USING btree ("source_session_id");
