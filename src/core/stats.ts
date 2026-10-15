/** Read models for the public pages: fund transparency, builds, audit log. */
import { desc, eq, sql } from "drizzle-orm";

import type { DbOrTx } from "../db/client.js";
import { auditLog, builds, fundEntries, ideas, users, walletEntries } from "../db/schema.js";

export interface FundSummary {
  buildBalanceCents: number;
  hostingBalanceCents: number;
  committedCents: number;
  buildSpendCents: number;
  screeningCents: number;
  walletsOutstandingCents: number;
}

export async function fundSummary(db: DbOrTx): Promise<FundSummary> {
  const [f] = await db
    .select({
      build: sql<number>`coalesce(sum(${fundEntries.deltaCents}) filter (where ${fundEntries.account} = 'build'), 0)::int`,
      hosting: sql<number>`coalesce(sum(${fundEntries.deltaCents}) filter (where ${fundEntries.account} = 'hosting'), 0)::int`,
      committed: sql<number>`coalesce(sum(${fundEntries.deltaCents}) filter (where ${fundEntries.kind} = 'commit'), 0)::int`,
      spend: sql<number>`coalesce(-sum(${fundEntries.deltaCents}) filter (where ${fundEntries.kind} = 'build_spend'), 0)::int`,
      screening: sql<number>`coalesce(-sum(${fundEntries.deltaCents}) filter (where ${fundEntries.kind} = 'screening'), 0)::int`,
    })
    .from(fundEntries);
  const [w] = await db.select({ cents: sql<number>`coalesce(sum(${walletEntries.deltaCents}), 0)::int` }).from(walletEntries);
  return {
    buildBalanceCents: f?.build ?? 0,
    hostingBalanceCents: f?.hosting ?? 0,
    committedCents: f?.committed ?? 0,
    buildSpendCents: f?.spend ?? 0,
    screeningCents: f?.screening ?? 0,
    walletsOutstandingCents: w?.cents ?? 0,
  };
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

export async function walletHistory(db: DbOrTx, userId: number, limit = 100) {
  return db
    .select()
    .from(walletEntries)
    .where(eq(walletEntries.userId, userId))
    .orderBy(desc(walletEntries.createdAt))
    .limit(limit);
}
