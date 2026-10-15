/**
 * What Claude costs (SPEC §2.1). There's no fund to top up: oojam may spend at most
 * DAILY_BUDGET_USD per UTC day, across the build, its review and idea screening. Spend is
 * metered per token and recorded as append-only entries; everything is public on /costs.
 */
import { and, eq, gte, sql } from "drizzle-orm";

import type { DbOrTx } from "../db/client.js";
import { fundEntries } from "../db/schema.js";
import { config } from "./config.js";
import { startOfUtcDay } from "./time.js";

/** Cents spent since a moment (entries are negative; this returns a positive number). */
export async function spentSinceCents(db: DbOrTx, since: Date): Promise<number> {
  const [row] = await db
    .select({ c: sql<number>`coalesce(-sum(${fundEntries.deltaCents}), 0)::int` })
    .from(fundEntries)
    .where(and(gte(fundEntries.createdAt, since), sql`${fundEntries.kind} in ('build_spend', 'screening', 'adjustment')`));
  return Math.max(0, row?.c ?? 0);
}

export const dailyBudgetCents = () => Math.round(config.dailyBudgetUsd * 100);

/** What's left of today's (UTC) budget. */
export async function budgetLeftTodayCents(db: DbOrTx, now = new Date()): Promise<number> {
  return Math.max(0, dailyBudgetCents() - (await spentSinceCents(db, startOfUtcDay(now))));
}

export async function chargeBuild(db: DbOrTx, buildId: number, cents: number, note: string): Promise<void> {
  if (cents <= 0) return;
  await db.insert(fundEntries).values({ deltaCents: -cents, kind: "build_spend", buildId, note });
}

export async function chargeScreening(db: DbOrTx, cents: number, note: string): Promise<void> {
  if (cents <= 0) return;
  await db.insert(fundEntries).values({ deltaCents: -cents, kind: "screening", note });
}

export async function buildSpendCents(db: DbOrTx, buildId: number): Promise<number> {
  const [row] = await db
    .select({ c: sql<number>`coalesce(-sum(${fundEntries.deltaCents}), 0)::int` })
    .from(fundEntries)
    .where(eq(fundEntries.buildId, buildId));
  return row?.c ?? 0;
}
