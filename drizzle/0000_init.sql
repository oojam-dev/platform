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
	"active_token" text,
	"skipped_idea_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
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
	"delta_cents" integer NOT NULL,
	"kind" text NOT NULL,
	"source" text,
	"build_id" bigint,
	"actor_id" bigint,
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
CREATE TABLE "ref_visits" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"idea_id" bigint,
	"referrer_id" bigint NOT NULL,
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
CREATE TABLE "shares" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"idea_id" bigint NOT NULL,
	"user_id" bigint,
	"channel" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
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
	"referred_by" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_github_id_unique" UNIQUE("github_id")
);
--> statement-breakpoint
CREATE TABLE "votes" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"idea_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"referrer_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "builds" ADD CONSTRAINT "builds_idea_id_ideas_id_fk" FOREIGN KEY ("idea_id") REFERENCES "public"."ideas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_idea_id_ideas_id_fk" FOREIGN KEY ("idea_id") REFERENCES "public"."ideas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "controls" ADD CONSTRAINT "controls_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_build_id_builds_id_fk" FOREIGN KEY ("build_id") REFERENCES "public"."builds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fund_entries" ADD CONSTRAINT "fund_entries_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ideas" ADD CONSTRAINT "ideas_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ref_visits" ADD CONSTRAINT "ref_visits_idea_id_ideas_id_fk" FOREIGN KEY ("idea_id") REFERENCES "public"."ideas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ref_visits" ADD CONSTRAINT "ref_visits_referrer_id_users_id_fk" FOREIGN KEY ("referrer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shares" ADD CONSTRAINT "shares_idea_id_ideas_id_fk" FOREIGN KEY ("idea_id") REFERENCES "public"."ideas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shares" ADD CONSTRAINT "shares_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "votes" ADD CONSTRAINT "votes_idea_id_ideas_id_fk" FOREIGN KEY ("idea_id") REFERENCES "public"."ideas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "votes" ADD CONSTRAINT "votes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "votes" ADD CONSTRAINT "votes_referrer_id_users_id_fk" FOREIGN KEY ("referrer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_created_idx" ON "audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "builds_status_idx" ON "builds" USING btree ("status");--> statement-breakpoint
CREATE INDEX "comments_idea_idx" ON "comments" USING btree ("idea_id","created_at");--> statement-breakpoint
CREATE INDEX "comments_user_idx" ON "comments" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "deployments_status_idx" ON "deployments" USING btree ("status");--> statement-breakpoint
CREATE INDEX "fund_entries_kind_idx" ON "fund_entries" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "fund_entries_build_idx" ON "fund_entries" USING btree ("build_id");--> statement-breakpoint
CREATE INDEX "ideas_board_idx" ON "ideas" USING btree ("status","vote_count","created_at");--> statement-breakpoint
CREATE INDEX "ideas_author_idx" ON "ideas" USING btree ("author_id");--> statement-breakpoint
CREATE INDEX "ref_visits_referrer_idx" ON "ref_visits" USING btree ("referrer_id");--> statement-breakpoint
CREATE INDEX "ref_visits_created_idx" ON "ref_visits" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "shares_idea_idx" ON "shares" USING btree ("idea_id");--> statement-breakpoint
CREATE INDEX "shares_created_idx" ON "shares" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "votes_idea_user_key" ON "votes" USING btree ("idea_id","user_id");--> statement-breakpoint
CREATE INDEX "votes_user_idx" ON "votes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "votes_referrer_idx" ON "votes" USING btree ("referrer_id");