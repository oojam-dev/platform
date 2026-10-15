/**
 * The build fund (SPEC §2.1): contributions from sponsors and maintainers in, builds and
 * screening out. The balance is the sum of append-only entries; everything is public on /fund.
 */
import { eq, sql } from "drizzle-orm";

import type { Database, DbOrTx } from "../db/client.js";
import { fundEntries } from "../db/schema.js";
import { audit } from "./controls.js";
import { RuleError } from "./errors.js";

export async function fundBalance(db: DbOrTx): Promise<number> {
  const [row] = await db.select({ cents: sql<number>`coalesce(sum(${fundEntries.deltaCents}), 0)::int` }).from(fundEntries);
  return row?.cents ?? 0;
}

/** An admin records money that went into the Anthropic account for oojam (sponsors, maintainers). */
export async function recordContribution(db: Database, actorId: number, cents: number, source: string, note = ""): Promise<void> {
  if (!Number.isInteger(cents) || cents <= 0) throw new RuleError("invalid", "A contribution is a positive amount.");
  if (!source.trim()) throw new RuleError("invalid", "Say where it came from (e.g. \"GitHub Sponsors, October\").");
  await db.insert(fundEntries).values({ deltaCents: cents, kind: "contribution", source: source.trim(), note: note.trim() || null, actorId });
  await audit(db, actorId, "contribution", "fund", { cents, source: source.trim() });
}

/** Corrections (either sign), always with a reason. */
export async function adjustFund(db: Database, actorId: number, cents: number, note: string): Promise<void> {
  if (!Number.isInteger(cents) || cents === 0) throw new RuleError("invalid", "Adjustment must be a non-zero whole number of cents.");
  if (!note.trim()) throw new RuleError("invalid", "Adjustments need a reason.");
  await db.insert(fundEntries).values({ deltaCents: cents, kind: "adjustment", note: note.trim(), actorId });
  await audit(db, actorId, "adjust_fund", "fund", { cents, note: note.trim() });
}

/** A build's real spend comes out of the fund. */
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
