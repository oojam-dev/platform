/** Admin actions (SPEC §6.4). Every one is audited publicly. */
import { and, asc, eq, like } from "drizzle-orm";

import type { Database } from "../db/client.js";
import { comments, controls, ideas, sessions, users } from "../db/schema.js";
import { audit } from "./controls.js";
import { LedgerError, adjustWallet } from "./ledger.js";

function needReason(reason: string) {
  if (!reason.trim()) throw new LedgerError("invalid", "A reason is required; it is published on /transparency.");
}

export async function hideIdea(db: Database, actorId: number, ideaId: number, reason: string) {
  needReason(reason);
  await db.update(ideas).set({ hiddenAt: new Date() }).where(eq(ideas.id, ideaId));
  await audit(db, actorId, "hide_idea", `idea:${ideaId}`, { reason });
}

/** Rejects an open idea. Votes already spent stay spent (they were the community's choice). */
export async function rejectIdea(db: Database, actorId: number, ideaId: number, reason: string) {
  needReason(reason);
  const rows = await db
    .update(ideas)
    .set({ status: "rejected", rejectedReason: reason, decidedAt: new Date() })
    .where(and(eq(ideas.id, ideaId), eq(ideas.status, "open")))
    .returning({ id: ideas.id });
  if (rows.length === 0) throw new LedgerError("invalid", "Only open ideas can be rejected; pause the system to stop a build in progress.");
  await audit(db, actorId, "reject_idea", `idea:${ideaId}`, { reason });
}

export async function hideComment(db: Database, actorId: number, commentId: number, reason: string) {
  needReason(reason);
  await db.update(comments).set({ hiddenAt: new Date() }).where(eq(comments.id, commentId));
  await audit(db, actorId, "hide_comment", `comment:${commentId}`, { reason });
}

export async function banUser(db: Database, actorId: number, userId: number, reason: string) {
  needReason(reason);
  await db.update(users).set({ bannedAt: new Date(), bannedReason: reason }).where(eq(users.id, userId));
  await db.delete(sessions).where(eq(sessions.userId, userId));
  await audit(db, actorId, "ban_user", `user:${userId}`, { reason });
}

export async function unbanUser(db: Database, actorId: number, userId: number, reason: string) {
  needReason(reason);
  await db.update(users).set({ bannedAt: null, bannedReason: null }).where(eq(users.id, userId));
  await audit(db, actorId, "unban_user", `user:${userId}`, { reason });
}

export async function adminAdjustWallet(db: Database, actorId: number, userId: number, cents: number, reason: string) {
  needReason(reason);
  await adjustWallet(db, userId, cents, reason);
  await audit(db, actorId, "adjust_wallet", `user:${userId}`, { cents, reason });
}

/**
 * Requests for the worker, which polls `controls` (the web app has no route to the worker).
 * `run_cycle` runs today's cycle now if it hasn't run; `rollback` restores a deployment.
 */
export type WorkerRequest =
  | { type: "run_cycle"; requestedAt: string; by: number }
  | { type: "rollback"; deploymentId: number; requestedAt: string; by: number };

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type WorkerRequestInput = DistributiveOmit<WorkerRequest, "requestedAt" | "by">;

/** One pending request per kind, so a rollback doesn't replace a queued run (or vice versa). */
export async function requestWorker(db: Database, actorId: number, req: WorkerRequestInput) {
  const value = { ...req, requestedAt: new Date().toISOString(), by: actorId } as WorkerRequest;
  const key = `worker_request:${req.type}`;
  await db
    .insert(controls)
    .values({ key, value, updatedBy: actorId })
    .onConflictDoUpdate({ target: controls.key, set: { value, updatedBy: actorId, updatedAt: new Date() } });
  await audit(db, actorId, `request_${req.type}`, "worker", req as Record<string, unknown>);
}

/** Takes (and clears) the oldest pending worker request, if any. */
export async function takeWorkerRequest(db: Database): Promise<WorkerRequest | undefined> {
  const [next] = await db
    .select({ key: controls.key })
    .from(controls)
    .where(like(controls.key, "worker_request:%"))
    .orderBy(asc(controls.updatedAt))
    .limit(1);
  if (!next) return undefined;
  const [row] = await db.delete(controls).where(eq(controls.key, next.key)).returning();
  return row?.value as WorkerRequest | undefined;
}
