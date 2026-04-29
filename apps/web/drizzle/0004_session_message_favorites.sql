CREATE TABLE IF NOT EXISTS "session_favorites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "message_favorites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
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
		SELECT 1 FROM pg_constraint WHERE conname = 'message_favorites_user_id_users_id_fk'
	) THEN
		ALTER TABLE "message_favorites" ADD CONSTRAINT "message_favorites_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'message_favorites_message_id_normalized_messages_id_fk'
	) THEN
		ALTER TABLE "message_favorites" ADD CONSTRAINT "message_favorites_message_id_normalized_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."normalized_messages"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_session_favorites_unique" ON "session_favorites" USING btree ("user_id","session_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_session_favorites_user" ON "session_favorites" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_session_favorites_session" ON "session_favorites" USING btree ("session_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_message_favorites_unique" ON "message_favorites" USING btree ("user_id","message_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_message_favorites_user" ON "message_favorites" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_message_favorites_message" ON "message_favorites" USING btree ("message_id");
