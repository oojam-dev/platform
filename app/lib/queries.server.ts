/**
 * Read-only queries the web UI needs that src/core doesn't (yet) provide. Nothing here
 * changes state; all writes go through src/core.
 */
import { and, desc, eq, ilike, inArray, like, ne, sql } from "drizzle-orm";

import type { WorkerRequest } from "../../src/core/admin.js";
import type { DbOrTx } from "../../src/db/client.js";
import { auditLog, builds, controls, deployments, ideas, users, votes } from "../../src/db/schema.js";

export async function recentDeployments(db: DbOrTx, limit = 20) {
  return db
    .select({
      id: deployments.id,
      buildId: deployments.buildId,
      sha: deployments.sha,
      container: deployments.container,
      status: deployments.status,
      createdAt: deployments.createdAt,
      promotedAt: deployments.promotedAt,
      day: builds.day,
      ideaTitle: ideas.title,
    })
    .from(deployments)
    .leftJoin(builds, eq(builds.id, deployments.buildId))
    .leftJoin(ideas, eq(ideas.id, builds.ideaId))
    .orderBy(desc(deployments.createdAt))
    .limit(limit);
}

/** Case-insensitive lookup by GitHub login (GitHub logins are case-insensitive). */
export async function userByLogin(db: DbOrTx, login: string) {
  const clean = login.trim().replace(/^@/, "");
  if (!/^[A-Za-z0-9-]{1,39}$/.test(clean)) return undefined;
  const [u] = await db.select().from(users).where(ilike(users.githubLogin, clean)).limit(1);
  return u;
}

export async function ideaTitles(db: DbOrTx, ids: number[]): Promise<Record<number, string>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return {};
  const rows = await db.select({ id: ideas.id, title: ideas.title }).from(ideas).where(inArray(ideas.id, unique));
  return Object.fromEntries(rows.map((r) => [r.id, r.title]));
}

/** GitHub logins for user ids, e.g. to label audit-log subjects. */
export async function loginsByIds(db: DbOrTx, ids: number[]): Promise<Record<number, string>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return {};
  const rows = await db.select({ id: users.id, login: users.githubLogin }).from(users).where(inArray(users.id, unique));
  return Object.fromEntries(rows.map((r) => [r.id, r.login]));
}

/** Pending worker requests (one per kind: `worker_request:<type>`). */
export async function pendingWorkerRequests(db: DbOrTx): Promise<WorkerRequest[]> {
  const rows = await db.select().from(controls).where(like(controls.key, "worker_request:%"));
  return rows.map((r) => r.value as WorkerRequest);
}

/** The reason a moderator gave for hiding an idea (it lives only in the public audit log). */
export async function hiddenReason(db: DbOrTx, ideaId: number): Promise<string | null> {
  const [row] = await db
    .select({ data: auditLog.data })
    .from(auditLog)
    .where(and(eq(auditLog.action, "hide_idea"), eq(auditLog.subject, `idea:${ideaId}`)))
    .orderBy(desc(auditLog.createdAt))
    .limit(1);
  const reason = row?.data?.reason;
  return typeof reason === "string" ? reason : null;
}

/** The ideas a user posted, newest first. */
export async function ideasByAuthor(db: DbOrTx, userId: number, limit = 50) {
  return db
    .select({
      id: ideas.id,
      title: ideas.title,
      status: ideas.status,
      voteCount: ideas.voteCount,
      screened: sql<boolean>`${ideas.screenVerdict} is not null`,
      hiddenAt: ideas.hiddenAt,
      createdAt: ideas.createdAt,
    })
    .from(ideas)
    .where(eq(ideas.authorId, userId))
    .orderBy(desc(ideas.createdAt))
    .limit(limit);
}

/** The ideas a user has voted for (other people's), newest vote first. */
export async function votedIdeas(db: DbOrTx, userId: number, limit = 50) {
  return db
    .select({
      id: ideas.id,
      title: ideas.title,
      status: ideas.status,
      voteCount: ideas.voteCount,
      votedAt: votes.createdAt,
    })
    .from(votes)
    .innerJoin(ideas, eq(ideas.id, votes.ideaId))
    .where(and(eq(votes.userId, userId), ne(ideas.authorId, userId)))
    .orderBy(desc(votes.createdAt))
    .limit(limit);
}

/** What a user's share links have brought in: votes, and accounts that signed up. */
export async function myReferrals(db: DbOrTx, userId: number): Promise<{ votes: number; signups: number }> {
  const [v] = await db.select({ n: sql<number>`count(*)::int` }).from(votes).where(eq(votes.referrerId, userId));
  const [u] = await db.select({ n: sql<number>`count(*)::int` }).from(users).where(eq(users.referredBy, userId));
  return { votes: v?.n ?? 0, signups: u?.n ?? 0 };
}

/** Whether an account already exists for this GitHub id (to spot sign-ups vs sign-ins). */
export async function githubUserExists(db: DbOrTx, githubId: number): Promise<boolean> {
  const [u] = await db.select({ id: users.id }).from(users).where(eq(users.githubId, githubId)).limit(1);
  return Boolean(u);
}

export async function ping(db: DbOrTx): Promise<boolean> {
  await db.execute(sql`select 1`);
  return true;
}
