/** Read models for the public pages: fund transparency, builds, audit log. */
import { desc, eq, sql } from "drizzle-orm";

import type { DbOrTx } from "../db/client.js";
import { auditLog, builds, fundEntries, ideas, users } from "../db/schema.js";
import { dailyBudgetCents } from "./spend.js";

export interface CostSummary {
  dailyBudgetCents: number;
  todayCents: number;
  monthCents: number;
  allTimeCents: number;
  buildCents: number;
  screeningCents: number;
}

/** Spend today, this month and all time (positive cents). */
export async function costSummary(db: DbOrTx, now = new Date()): Promise<CostSummary> {
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const spent = (extra = sql`true`) => sql<number>`coalesce(-sum(${fundEntries.deltaCents}) filter (where ${extra}), 0)::int`;
  const [r] = await db
    .select({
      today: spent(sql`${fundEntries.createdAt} >= ${day}`),
      month: spent(sql`${fundEntries.createdAt} >= ${month}`),
      all: spent(),
      build: spent(sql`${fundEntries.kind} = 'build_spend'`),
      screening: spent(sql`${fundEntries.kind} = 'screening'`),
    })
    .from(fundEntries)
    .where(sql`${fundEntries.kind} in ('build_spend', 'screening', 'adjustment')`);
  return {
    dailyBudgetCents: dailyBudgetCents(),
    todayCents: r?.today ?? 0,
    monthCents: r?.month ?? 0,
    allTimeCents: r?.all ?? 0,
    buildCents: r?.build ?? 0,
    screeningCents: r?.screening ?? 0,
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
