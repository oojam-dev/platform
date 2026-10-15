ALTER TABLE "builds" ADD COLUMN "active_token" text;--> statement-breakpoint
ALTER TABLE "builds" ADD COLUMN "skipped_idea_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;