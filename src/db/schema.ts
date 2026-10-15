/**
 * The platform database (SPEC §6.2). Money is integer cents everywhere, and every
 * balance is the sum of append-only entries: nothing stores a balance.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const id = () => bigserial("id", { mode: "number" }).primaryKey();
const ref = (name: string) => bigint(name, { mode: "number" });
const createdAt = () => timestamp("created_at", { withTimezone: true }).defaultNow().notNull();
const ts = (name: string) => timestamp(name, { withTimezone: true });

export const users = pgTable("users", {
  id: id(),
  githubId: bigint("github_id", { mode: "number" }).notNull().unique(),
  githubLogin: text("github_login").notNull(),
  name: text("name"),
  avatarUrl: text("avatar_url"),
  githubCreatedAt: ts("github_created_at"),
  isAdmin: boolean("is_admin").default(false).notNull(),
  bannedAt: ts("banned_at"),
  bannedReason: text("banned_reason"),
  createdAt: createdAt(),
});

export const sessions = pgTable(
  "sessions",
  {
    /** sha256(token), hex. The token itself is only ever in the cookie. */
    id: text("id").primaryKey(),
    userId: ref("user_id").notNull().references(() => users.id),
    expiresAt: ts("expires_at").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

export type TopupStatus = "pending" | "paid" | "failed" | "refunded" | "disputed";

export const topups = pgTable(
  "topups",
  {
    id: id(),
    userId: ref("user_id").notNull().references(() => users.id),
    stripeCheckoutId: text("stripe_checkout_id").unique(),
    stripePaymentIntent: text("stripe_payment_intent"),
    amountCents: integer("amount_cents").notNull(),
    status: text("status").$type<TopupStatus>().notNull().default("pending"),
    createdAt: createdAt(),
    paidAt: ts("paid_at"),
  },
  (t) => [
    index("topups_user_idx").on(t.userId),
    index("topups_payment_intent_idx").on(t.stripePaymentIntent),
    check("topups_amount_check", sql`${t.amountCents} > 0`),
  ],
);

export type WalletKind = "topup" | "post" | "vote" | "refund" | "adjustment";

export const walletEntries = pgTable(
  "wallet_entries",
  {
    id: id(),
    userId: ref("user_id").notNull().references(() => users.id),
    deltaCents: integer("delta_cents").notNull(),
    kind: text("kind").$type<WalletKind>().notNull(),
    topupId: ref("topup_id").references(() => topups.id),
    ideaId: ref("idea_id"),
    note: text("note"),
    createdAt: createdAt(),
  },
  (t) => [
    index("wallet_entries_user_idx").on(t.userId),
    // A top-up is credited at most once, whatever Stripe redelivers.
    uniqueIndex("wallet_entries_topup_once").on(t.topupId).where(sql`${t.kind} = 'topup'`),
  ],
);

export type FundAccount = "build" | "hosting";
export type FundKind = "commit" | "build_spend" | "screening" | "adjustment";

export const fundEntries = pgTable(
  "fund_entries",
  {
    id: id(),
    account: text("account").$type<FundAccount>().notNull(),
    deltaCents: integer("delta_cents").notNull(),
    kind: text("kind").$type<FundKind>().notNull(),
    walletEntryId: ref("wallet_entry_id").references(() => walletEntries.id),
    buildId: ref("build_id"),
    note: text("note"),
    createdAt: createdAt(),
  },
  (t) => [index("fund_entries_account_idx").on(t.account), index("fund_entries_build_idx").on(t.buildId)],
);

export type IdeaStatus = "open" | "frozen" | "building" | "deployed" | "failed" | "rejected" | "withdrawn";

export interface ScreenVerdict {
  allowed: boolean;
  category: string;
  reason: string;
  model: string;
  at: string;
}

export const ideas = pgTable(
  "ideas",
  {
    id: id(),
    authorId: ref("author_id").notNull().references(() => users.id),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    status: text("status").$type<IdeaStatus>().notNull().default("open"),
    voteCount: integer("vote_count").notNull().default(0),
    screenVerdict: jsonb("screen_verdict").$type<ScreenVerdict>(),
    rejectedReason: text("rejected_reason"),
    hiddenAt: ts("hidden_at"),
    frozenAt: ts("frozen_at"),
    decidedAt: ts("decided_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("ideas_board_idx").on(t.status, t.voteCount, t.createdAt),
    index("ideas_author_idx").on(t.authorId),
  ],
);

export const votes = pgTable(
  "votes",
  {
    id: id(),
    ideaId: ref("idea_id").notNull().references(() => ideas.id),
    userId: ref("user_id").notNull().references(() => users.id),
    walletEntryId: ref("wallet_entry_id").notNull().unique().references(() => walletEntries.id),
    createdAt: createdAt(),
  },
  (t) => [index("votes_idea_user_idx").on(t.ideaId, t.userId)],
);

export const comments = pgTable(
  "comments",
  {
    id: id(),
    ideaId: ref("idea_id").notNull().references(() => ideas.id),
    userId: ref("user_id").notNull().references(() => users.id),
    body: text("body").notNull(),
    hiddenAt: ts("hidden_at"),
    createdAt: createdAt(),
  },
  (t) => [index("comments_idea_idx").on(t.ideaId, t.createdAt), index("comments_user_idx").on(t.userId, t.createdAt)],
);

export type BuildStatus =
  | "queued"
  | "screening"
  | "building"
  | "gating"
  | "pr_open"
  | "merging"
  | "deploying"
  | "deployed"
  | "failed"
  | "rolled_back"
  | "skipped";

export interface BuildLogEntry {
  at: string;
  step: string;
  message: string;
}

export const builds = pgTable(
  "builds",
  {
    id: id(),
    /** The UTC day this build is for. One build per day. */
    day: date("day", { mode: "string" }).notNull().unique(),
    ideaId: ref("idea_id").references(() => ideas.id),
    status: text("status").$type<BuildStatus>().notNull().default("queued"),
    attempt: integer("attempt").notNull().default(0),
    budgetCents: integer("budget_cents").notNull().default(0),
    costCents: integer("cost_cents").notNull().default(0),
    branch: text("branch"),
    baseSha: text("base_sha"),
    prNumber: integer("pr_number"),
    prUrl: text("pr_url"),
    mergeSha: text("merge_sha"),
    /** The gateway token of the attempt in progress, so a restarted worker can still meter it. */
    activeToken: text("active_token"),
    /** Ideas rejected at the pre-build screen today, so the runner-up is tried next. */
    skippedIdeaIds: jsonb("skipped_idea_ids").$type<number[]>().notNull().default([]),
    gateReport: text("gate_report"),
    summary: text("summary"),
    error: text("error"),
    log: jsonb("log").$type<BuildLogEntry[]>().notNull().default([]),
    startedAt: ts("started_at"),
    finishedAt: ts("finished_at"),
    createdAt: createdAt(),
  },
  (t) => [index("builds_status_idx").on(t.status)],
);

export type DeploymentStatus = "candidate" | "live" | "retired" | "failed";

export const deployments = pgTable(
  "deployments",
  {
    id: id(),
    buildId: ref("build_id").references(() => builds.id),
    sha: text("sha").notNull(),
    container: text("container").notNull(),
    status: text("status").$type<DeploymentStatus>().notNull(),
    createdAt: createdAt(),
    promotedAt: ts("promoted_at"),
  },
  (t) => [index("deployments_status_idx").on(t.status)],
);

export const controls = pgTable("controls", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedBy: ref("updated_by").references(() => users.id),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const stripeEvents = pgTable("stripe_events", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
});

export const auditLog = pgTable(
  "audit_log",
  {
    id: id(),
    actorId: ref("actor_id").references(() => users.id),
    action: text("action").notNull(),
    subject: text("subject").notNull(),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index("audit_log_created_idx").on(t.createdAt)],
);
