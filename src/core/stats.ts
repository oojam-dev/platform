/** Read models for the public pages: fund transparency, builds, audit log. */
import { desc, eq, sql } from "drizzle-orm";

import type { DbOrTx } from "../db/client.js";
import { auditLog, builds, fundEntries, ideas, users } from "../db/schema.js";

export interface FundSummary {
  balanceCents: number;
  contributedCents: number;
  buildSpendCents: number;
  screeningCents: number;
  adjustmentsCents: number;
}

export async function fundSummary(db: DbOrTx): Promise<FundSummary> {
  const sum = (kind: string) => sql<number>`coalesce(sum(${fundEntries.deltaCents}) filter (where ${fundEntries.kind} = ${kind}), 0)::int`;
  const [f] = await db
    .select({
      balance: sql<number>`coalesce(sum(${fundEntries.deltaCents}), 0)::int`,
      contributed: sum("contribution"),
      spend: sum("build_spend"),
      screening: sum("screening"),
      adjustments: sum("adjustment"),
    })
    .from(fundEntries);
  return {
    balanceCents: f?.balance ?? 0,
    contributedCents: f?.contributed ?? 0,
    buildSpendCents: -(f?.spend ?? 0),
    screeningCents: -(f?.screening ?? 0),
    adjustmentsCents: f?.adjustments ?? 0,
  };
}

/** Recent contributions, newest first (public). */
export async function listContributions(db: DbOrTx, limit = 50) {
  return db
    .select({ id: fundEntries.id, cents: fundEntries.deltaCents, source: fundEntries.source, note: fundEntries.note, createdAt: fundEntries.createdAt })
    .from(fundEntries)
    .where(eq(fundEntries.kind, "contribution"))
    .orderBy(desc(fundEntries.createdAt))
    .limit(limit);
}

export async function listBuilds(db: DbOrTx, limit = 60) {
  return db
    .select({
      id: builds.id,
      day: builds.day,
      status: builds.status,
      costCents: builds.costCents,
      budgetCents: builds.budgetCents,
      prUrl: builds.prUrl,
      error: builds.error,
      ideaId: builds.ideaId,
      ideaTitle: ideas.title,
      finishedAt: builds.finishedAt,
    })
    .from(builds)
    .leftJoin(ideas, eq(ideas.id, builds.ideaId))
    .orderBy(desc(builds.day))
    .limit(limit);
}

export async function getBuild(db: DbOrTx, id: number) {
  const [row] = await db
    .select({ build: builds, ideaTitle: ideas.title, ideaBody: ideas.body })
    .from(builds)
    .leftJoin(ideas, eq(ideas.id, builds.ideaId))
    .where(eq(builds.id, id));
  return row ? { ...row.build, ideaTitle: row.ideaTitle, ideaBody: row.ideaBody } : undefined;
}

export async function listAudit(db: DbOrTx, limit = 200) {
  return db
    .select({
      id: auditLog.id,
      action: auditLog.action,
      subject: auditLog.subject,
      data: auditLog.data,
      createdAt: auditLog.createdAt,
      actor: users.githubLogin,
    })
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.actorId))
    .orderBy(desc(auditLog.createdAt))
    .limit(limit);
}
