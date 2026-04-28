CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" uuid,
	"details" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "config_push_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"config_id" uuid NOT NULL,
	"machine_id" uuid NOT NULL,
	"pushed_by" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"pushed_at" timestamp with time zone,
	"acked_at" timestamp with time zone,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "config_read_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"machine_id" uuid NOT NULL,
	"file_path" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"content" jsonb,
	"error" text,
	"requested_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "daily_stats" (
	"day" date NOT NULL,
	"machine_id" uuid NOT NULL,
	"owner_id" uuid,
	"source_tool" text NOT NULL,
	"model" text,
	"message_count" integer DEFAULT 0 NOT NULL,
	"session_count" integer DEFAULT 0 NOT NULL,
	"total_input_tokens" bigint DEFAULT 0 NOT NULL,
	"total_output_tokens" bigint DEFAULT 0 NOT NULL,
	"total_cache_tokens" bigint DEFAULT 0 NOT NULL,
	"estimated_cost_usd" numeric(12, 4) DEFAULT '0' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "device_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"config_type" text NOT NULL,
	"config_payload" jsonb NOT NULL,
	"file_path" text,
	"target_type" text NOT NULL,
	"target_ids" uuid[],
	"target_group" text,
	"version" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "machines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fingerprint" text NOT NULL,
	"os_username" text,
	"display_name" text,
	"os_info" jsonb,
	"owner_id" uuid,
	"auth_key" uuid DEFAULT gen_random_uuid() NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"agent_version" text,
	"local_configs" jsonb,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "machines_auth_key_unique" UNIQUE("auth_key")
);
--> statement-breakpoint
CREATE TABLE "normalized_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" text NOT NULL,
	"parent_id" text,
	"machine_id" uuid NOT NULL,
	"source_tool" text NOT NULL,
	"role" text NOT NULL,
	"content_blocks" jsonb,
	"usage" jsonb,
	"raw_timestamp" timestamp with time zone NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pricing_table" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"model" text NOT NULL,
	"provider" text NOT NULL,
	"input_price_per_mtok" numeric(10, 4) NOT NULL,
	"output_price_per_mtok" numeric(10, 4) NOT NULL,
	"cache_price_per_mtok" numeric(10, 4),
	"effective_from" date NOT NULL,
	"effective_to" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "raw_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"machine_id" uuid NOT NULL,
	"source_tool" text NOT NULL,
	"source_file_path" text NOT NULL,
	"raw_content" text NOT NULL,
	"content_hash" text NOT NULL,
	"byte_offset_start" bigint,
	"byte_offset_end" bigint,
	"parsed_at" timestamp with time zone,
	"parse_version" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"role" text DEFAULT 'viewer' NOT NULL,
	"password_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "config_push_logs" ADD CONSTRAINT "config_push_logs_config_id_device_configs_id_fk" FOREIGN KEY ("config_id") REFERENCES "public"."device_configs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "config_push_logs" ADD CONSTRAINT "config_push_logs_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "config_push_logs" ADD CONSTRAINT "config_push_logs_pushed_by_users_id_fk" FOREIGN KEY ("pushed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "config_read_requests" ADD CONSTRAINT "config_read_requests_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "config_read_requests" ADD CONSTRAINT "config_read_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_configs" ADD CONSTRAINT "device_configs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machines" ADD CONSTRAINT "machines_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_push_logs_config" ON "config_push_logs" USING btree ("config_id");--> statement-breakpoint
CREATE INDEX "idx_push_logs_machine" ON "config_push_logs" USING btree ("machine_id");--> statement-breakpoint
CREATE INDEX "idx_config_read_machine" ON "config_read_requests" USING btree ("machine_id","status");--> statement-breakpoint
CREATE INDEX "idx_daily_stats_owner" ON "daily_stats" USING btree ("owner_id","day");--> statement-breakpoint
CREATE INDEX "idx_daily_stats_day" ON "daily_stats" USING btree ("day");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_machines_fingerprint_user" ON "machines" USING btree ("fingerprint","os_username");--> statement-breakpoint
CREATE INDEX "idx_machines_auth_key" ON "machines" USING btree ("auth_key");--> statement-breakpoint
CREATE INDEX "idx_machines_status" ON "machines" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_machines_owner" ON "machines" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "idx_nm_machine_time" ON "normalized_messages" USING btree ("machine_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_nm_session" ON "normalized_messages" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "idx_nm_source_tool" ON "normalized_messages" USING btree ("source_tool","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_pricing_unique" ON "pricing_table" USING btree ("model","provider","effective_from");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_raw_events_unique" ON "raw_events" USING btree ("machine_id","source_file_path","content_hash");