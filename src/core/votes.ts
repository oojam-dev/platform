/**
 * Votes (SPEC §2.2). One vote per GitHub account per idea, on as many ideas as you like, and
 * public: anyone can see who voted. Posting an idea is the author's vote for it. Posting is
 * limited per day; voting isn't, because sharing an idea to get votes is the point.
 */
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { Database, DbOrTx, Tx } from "../db/client.js";
import { ideas, users, votes, type ScreenVerdict } from "../db/schema.js";
import { config } from "./config.js";
import { RuleError } from "./errors.js";
import { startOfUtcDay } from "./time.js";

async function lockUser(tx: Tx, userId: number) {
  const [user] = await tx.select().from(users).where(eq(users.id, userId)).for("update");
  if (!user) throw new RuleError("not_found", "No such user.");
  if (user.bannedAt) throw new RuleError("banned", "This account is suspended.");
  return user;
}

export const TITLE_MIN = 8;
export const TITLE_MAX = 120;
export const BODY_MAX = 4_000;

export function validateIdea(title: string, body: string): { title: string; body: string } {
  const t = title.replace(/\s+/g, " ").trim();
  const b = body.replace(/\r\n/g, "\n").trim();
  if (t.length < TITLE_MIN || t.length > TITLE_MAX) {
    throw new RuleError("invalid", `Title must be ${TITLE_MIN}–${TITLE_MAX} characters.`);
  }
  if (b.length > BODY_MAX) throw new RuleError("invalid", `Description must be at most ${BODY_MAX} characters.`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(t + b)) throw new RuleError("invalid", "Remove control characters.");
  return { title: t, body: b };
}

/** An idea rejected at screening doesn't count towards the daily post limit. */
const rejectedAtScreening = sql`(${ideas.screenVerdict} ->> 'allowed')::boolean is false`;

/** Ideas posted today: attempts (everything) and posts (excluding screening rejections). */
export async function postsToday(db: DbOrTx, userId: number, now = new Date()): Promise<{ attempts: number; posts: number }> {
  const [row] = await db
    .select({
      attempts: sql<number>`count(*)::int`,
      posts: sql<number>`(count(*) filter (where not coalesce(${rejectedAtScreening}, false)))::int`,
    })
    .from(ideas)
    .where(and(eq(ideas.authorId, userId), gte(ideas.createdAt, startOfUtcDay(now))));
  return { attempts: row?.attempts ?? 0, posts: row?.posts ?? 0 };
}

/** Posts an idea; the author's vote comes with it. Screening happens after. */
export async function postIdea(db: Database, userId: number, input: { title: string; body: string }) {
  const { title, body } = validateIdea(input.title, input.body);
  return db.transaction(async (tx) => {
    const user = await lockUser(tx, userId);
    const today = await postsToday(tx, userId);
    if (today.posts >= config.maxIdeasPerDay) {
      throw new RuleError("post_limit", `You can post ${config.maxIdeasPerDay === 1 ? "one idea" : `${config.maxIdeasPerDay} ideas`} a day. Come back after 00:00 UTC.`);
    }
    if (today.attempts >= config.maxPostAttemptsPerDay) {
      throw new RuleError("post_limit", "That's enough attempts for today. Try again after 00:00 UTC.");
    }
    const [idea] = await tx.insert(ideas).values({ authorId: userId, title, body, voteCount: 1 }).returning();
    await tx.insert(votes).values({ ideaId: idea!.id, userId, referrerId: user.referredBy ?? null });
    return idea!;
  });
}

/**
 * Screening rejected a new idea: close it. Only for ideas nobody else could have voted on yet
 * (still unscreened). Idempotent.
 */
export async function rejectAtScreening(db: Database, ideaId: number, verdict: ScreenVerdict): Promise<void> {
  await db.transaction(async (tx) => {
    const [idea] = await tx.select().from(ideas).where(eq(ideas.id, ideaId)).for("update");
    if (!idea) throw new RuleError("not_found", "No such idea.");
    if (idea.status !== "open" || idea.screenVerdict) return;
    await tx.delete(votes).where(eq(votes.ideaId, ideaId));
    await tx
      .update(ideas)
      .set({ status: "rejected", rejectedReason: verdict.reason, screenVerdict: verdict, voteCount: 0, decidedAt: new Date() })
      .where(eq(ideas.id, ideaId));
  });
}

async function lockOpenIdea(tx: Tx, ideaId: number) {
  const [idea] = await tx.select().from(ideas).where(eq(ideas.id, ideaId)).for("update");
  if (!idea || idea.hiddenAt) throw new RuleError("not_found", "No such idea.");
  if (idea.status !== "open" || !idea.screenVerdict?.allowed) {
    throw new RuleError("idea_closed", "This idea isn't taking votes.");
  }
  return idea;
}

/**
 * Votes for an idea. Idempotent: voting twice is still one vote. `referrerId` is whose share
 * link brought the voter here (ignored if it's the voter themself).
 */
export async function vote(db: Database, userId: number, ideaId: number, referrerId: number | null = null): Promise<{ voteCount: number; voted: true }> {
  return db.transaction(async (tx) => {
    await lockUser(tx, userId);
    const idea = await lockOpenIdea(tx, ideaId);
    const inserted = await tx
      .insert(votes)
      .values({ ideaId, userId, referrerId: referrerId && referrerId !== userId ? referrerId : null })
      .onConflictDoNothing()
      .returning({ id: votes.id });
    if (inserted.length === 0) return { voteCount: idea.voteCount, voted: true as const };
    const [updated] = await tx
      .update(ideas)
      .set({ voteCount: sql`${ideas.voteCount} + 1` })
      .where(eq(ideas.id, ideaId))
      .returning({ voteCount: ideas.voteCount });
    return { voteCount: updated!.voteCount, voted: true as const };
  });
}

/** Takes a vote back while the idea is still open. Idempotent. */
export async function unvote(db: Database, userId: number, ideaId: number): Promise<{ voteCount: number; voted: false }> {
  return db.transaction(async (tx) => {
    await lockUser(tx, userId);
    const idea = await lockOpenIdea(tx, ideaId);
    const removed = await tx
      .delete(votes)
      .where(and(eq(votes.ideaId, ideaId), eq(votes.userId, userId)))
      .returning({ id: votes.id });
    if (removed.length === 0) return { voteCount: idea.voteCount, voted: false as const };
    const [updated] = await tx
      .update(ideas)
      .set({ voteCount: sql`greatest(${ideas.voteCount} - 1, 0)` })
      .where(eq(ideas.id, ideaId))
      .returning({ voteCount: ideas.voteCount });
    return { voteCount: updated!.voteCount, voted: false as const };
  });
}

/** Which of these ideas the user has voted on. */
export async function votedOn(db: DbOrTx, userId: number, ideaIds: number[]): Promise<Set<number>> {
  if (ideaIds.length === 0) return new Set();
  const rows = await db
    .select({ ideaId: votes.ideaId })
    .from(votes)
    .where(and(eq(votes.userId, userId), inArray(votes.ideaId, ideaIds)));
  return new Set(rows.map((r) => r.ideaId));
}

/** Everyone who voted for an idea, newest first, and whose share brought them. Public. */
export async function listVoters(db: DbOrTx, ideaId: number, limit = 200) {
  const referrer = alias(users, "referrer");
  return db
    .select({ login: users.githubLogin, avatarUrl: users.avatarUrl, createdAt: votes.createdAt, via: referrer.githubLogin })
    .from(votes)
    .innerJoin(users, eq(users.id, votes.userId))
    .leftJoin(referrer, eq(referrer.id, votes.referrerId))
    .where(eq(votes.ideaId, ideaId))
    .orderBy(desc(votes.createdAt))
    .limit(limit);
}
