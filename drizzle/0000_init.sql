CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"actor_id" bigint,
	"action" text NOT NULL,
	"subject" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "builds" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"day" date NOT NULL,
	"idea_id" bigint,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"budget_cents" integer DEFAULT 0 NOT NULL,
	"cost_cents" integer DEFAULT 0 NOT NULL,
	"branch" text,
	"base_sha" text,
	"pr_number" integer,
	"pr_url" text,
	"merge_sha" text,
	"gate_report" text,
	"summary" text,
	"error" text,
	"log" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "builds_day_unique" UNIQUE("day")
);
--> statement-breakpoint
CREATE TABLE "comments" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"idea_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"body" text NOT NULL,
	"hidden_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "controls" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_by" bigint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deployments" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"build_id" bigint,
	"sha" text NOT NULL,
	"container" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"promoted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "fund_entries" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"account" text NOT NULL,
	"delta_cents" integer NOT NULL,
	"kind" text NOT NULL,
	"wallet_entry_id" bigint,
	"build_id" bigint,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ideas" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"author_id" bigint NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"vote_count" integer DEFAULT 0 NOT NULL,
	"screen_verdict" jsonb,
	"rejected_reason" text,
	"hidden_at" timestamp with time zone,
	"frozen_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" bigint NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stripe_events" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "topups" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" bigint NOT NULL,
	"stripe_checkout_id" text,
	"stripe_payment_intent" text,
	"amount_cents" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"paid_at" timestamp with time zone,
	CONSTRAINT "topups_stripe_checkout_id_unique" UNIQUE("stripe_checkout_id"),
	CONSTRAINT "topups_amount_check" CHECK ("topups"."amount_cents" > 0)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"github_id" bigint NOT NULL,
	"github_login" text NOT NULL,
	"name" text,
	"avatar_url" text,
	"github_created_at" timestamp with time zone,
	"is_admin" boolean DEFAULT false NOT NULL,
	"banned_at" timestamp with time zone,
	"banned_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_github_id_unique" UNIQUE("github_id")
);
--> statement-breakpoint
CREATE TABLE "votes" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"idea_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"wallet_entry_id" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "votes_wallet_entry_id_unique" UNIQUE("wallet_entry_id")
);
--> statement-breakpoint
CREATE TABLE "wallet_entries" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" bigint NOT NULL,
	"delta_cents" integer NOT NULL,
	"kind" text NOT NULL,
	"topup_id" bigint,
	"idea_id" bigint,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "builds" ADD CONSTRAINT "builds_idea_id_ideas_id_fk" FOREIGN KEY ("idea_id") REFERENCES "public"."ideas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_idea_id_ideas_id_fk" FOREIGN KEY ("idea_id") REFERENCES "public"."ideas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "controls" ADD CONSTRAINT "controls_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_build_id_builds_id_fk" FOREIGN KEY ("build_id") REFERENCES "public"."builds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fund_entries" ADD CONSTRAINT "fund_entries_wallet_entry_id_wallet_entries_id_fk" FOREIGN KEY ("wallet_entry_id") REFERENCES "public"."wallet_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ideas" ADD CONSTRAINT "ideas_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topups" ADD CONSTRAINT "topups_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "votes" ADD CONSTRAINT "votes_idea_id_ideas_id_fk" FOREIGN KEY ("idea_id") REFERENCES "public"."ideas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "votes" ADD CONSTRAINT "votes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "votes" ADD CONSTRAINT "votes_wallet_entry_id_wallet_entries_id_fk" FOREIGN KEY ("wallet_entry_id") REFERENCES "public"."wallet_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_entries" ADD CONSTRAINT "wallet_entries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_entries" ADD CONSTRAINT "wallet_entries_topup_id_topups_id_fk" FOREIGN KEY ("topup_id") REFERENCES "public"."topups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_created_idx" ON "audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "builds_status_idx" ON "builds" USING btree ("status");--> statement-breakpoint
CREATE INDEX "comments_idea_idx" ON "comments" USING btree ("idea_id","created_at");--> statement-breakpoint
CREATE INDEX "comments_user_idx" ON "comments" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "deployments_status_idx" ON "deployments" USING btree ("status");--> statement-breakpoint
CREATE INDEX "fund_entries_account_idx" ON "fund_entries" USING btree ("account");--> statement-breakpoint
CREATE INDEX "fund_entries_build_idx" ON "fund_entries" USING btree ("build_id");--> statement-breakpoint
CREATE INDEX "ideas_board_idx" ON "ideas" USING btree ("status","vote_count","created_at");--> statement-breakpoint
CREATE INDEX "ideas_author_idx" ON "ideas" USING btree ("author_id");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "topups_user_idx" ON "topups" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "topups_payment_intent_idx" ON "topups" USING btree ("stripe_payment_intent");--> statement-breakpoint
CREATE INDEX "votes_idea_user_idx" ON "votes" USING btree ("idea_id","user_id");--> statement-breakpoint
CREATE INDEX "wallet_entries_user_idx" ON "wallet_entries" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_entries_topup_once" ON "wallet_entries" USING btree ("topup_id") WHERE "wallet_entries"."kind" = 'topup';