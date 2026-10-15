/**
 * Read-only queries the web UI needs that src/core doesn't (yet) provide. Nothing here
 * moves money or changes state; all writes go through src/core.
 */
import { and, asc, desc, eq, ilike, inArray, like, sql } from "drizzle-orm";

import type { DbOrTx } from "../../src/db/client.js";
import { builds, controls, deployments, ideas, topups, users, votes } from "../../src/db/schema.js";
import type { WorkerRequest } from "../../src/core/admin.js";

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

/** How many votes the viewer has on each of these ideas. */
export async function myVoteCounts(db: DbOrTx, userId: number, ideaIds: number[]): Promise<Record<number, number>> {
  if (ideaIds.length === 0) return {};
  const rows = await db
    .select({ ideaId: votes.ideaId, n: sql<number>`count(*)::int` })
    .from(votes)
    .where(and(eq(votes.userId, userId), inArray(votes.ideaId, ideaIds)))
    .groupBy(votes.ideaId);
  return Object.fromEntries(rows.map((r) => [r.ideaId, r.n]));
}

export async function ideaTitles(db: DbOrTx, ids: number[]): Promise<Record<number, string>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return {};
  const rows = await db.select({ id: ideas.id, title: ideas.title }).from(ideas).where(inArray(ideas.id, unique));
  return Object.fromEntries(rows.map((r) => [r.id, r.title]));
}

/** Checkouts the user started that Stripe hasn't confirmed yet. */
export async function pendingTopups(db: DbOrTx, userId: number) {
  return db
    .select({ id: topups.id, amountCents: topups.amountCents, createdAt: topups.createdAt })
    .from(topups)
    .where(and(eq(topups.userId, userId), eq(topups.status, "pending"), sql`${topups.stripeCheckoutId} is not null`))
    .orderBy(desc(topups.createdAt))
    .limit(5);
}

export async function pendingWorkerRequest(db: DbOrTx): Promise<WorkerRequest | undefined> {
  const [row] = await db.select().from(controls).where(like(controls.key, "worker_request:%")).orderBy(asc(controls.updatedAt)).limit(1);
  return row?.value as WorkerRequest | undefined;
}

export async function ping(db: DbOrTx): Promise<boolean> {
  await db.execute(sql`select 1`);
  return true;
}

/** GitHub logins for user ids, e.g. to label audit-log subjects. */
export async function loginsByIds(db: DbOrTx, ids: number[]): Promise<Record<number, string>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return {};
  const rows = await db.select({ id: users.id, login: users.githubLogin }).from(users).where(inArray(users.id, unique));
  return Object.fromEntries(rows.map((r) => [r.id, r.login]));
}
