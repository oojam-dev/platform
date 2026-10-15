/**
 * Money (SPEC §2.1, §6.3). Every operation is one transaction. Balances are sums of
 * append-only entries; the user row is locked (SELECT … FOR UPDATE) before any debit so
 * two concurrent commits can't both spend the same last credit.
 */
import { and, eq, sql } from "drizzle-orm";

import type { Database, DbOrTx, Tx } from "../db/client.js";
import { fundEntries, ideas, sessions, topups, users, votes, walletEntries, type FundAccount } from "../db/schema.js";
import { CREDIT_CENTS, config } from "./config.js";

export type LedgerErrorCode =
  | "insufficient_funds"
  | "banned"
  | "vote_cap"
  | "idea_closed"
  | "not_found"
  | "invalid";

export class LedgerError extends Error {
  constructor(
    public code: LedgerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "LedgerError";
  }
}

/** How one committed credit splits: hosting rounds down, the build fund gets the rest. */
export function splitCredit(cents = CREDIT_CENTS, buildShare = config.buildFundShare): { build: number; hosting: number } {
  if (!(buildShare >= 0 && buildShare <= 1)) throw new Error("BUILD_FUND_SHARE must be between 0 and 1");
  const hosting = Math.floor(cents * (1 - buildShare) + 1e-9);
  return { build: cents - hosting, hosting };
}

export async function walletBalance(db: DbOrTx, userId: number): Promise<number> {
  const [row] = await db
    .select({ cents: sql<number>`coalesce(sum(${walletEntries.deltaCents}), 0)::int` })
    .from(walletEntries)
    .where(eq(walletEntries.userId, userId));
  return row?.cents ?? 0;
}

export async function fundBalance(db: DbOrTx, account: FundAccount = "build"): Promise<number> {
  const [row] = await db
    .select({ cents: sql<number>`coalesce(sum(${fundEntries.deltaCents}), 0)::int` })
    .from(fundEntries)
    .where(eq(fundEntries.account, account));
  return row?.cents ?? 0;
}

async function lockUser(tx: Tx, userId: number) {
  const [user] = await tx.select().from(users).where(eq(users.id, userId)).for("update");
  if (!user) throw new LedgerError("not_found", "No such user.");
  return user;
}

/**
 * Spends one credit from the user's wallet into the funds. Caller holds the transaction.
 * Returns the wallet entry id so the post/vote can point at it.
 */
async function commitCredit(tx: Tx, userId: number, kind: "post" | "vote", ideaId: number | null): Promise<number> {
  const user = await lockUser(tx, userId);
  if (user.bannedAt) throw new LedgerError("banned", "This account is suspended.");
  const balance = await walletBalance(tx, userId);
  if (balance < CREDIT_CENTS) {
    throw new LedgerError("insufficient_funds", "You need at least $1 of credit. Top up your wallet first.");
  }
  const [entry] = await tx
    .insert(walletEntries)
    .values({ userId, deltaCents: -CREDIT_CENTS, kind, ideaId })
    .returning({ id: walletEntries.id });
  const split = splitCredit();
  await tx.insert(fundEntries).values([
    { account: "build", deltaCents: split.build, kind: "commit", walletEntryId: entry!.id },
    { account: "hosting", deltaCents: split.hosting, kind: "commit", walletEntryId: entry!.id },
  ]);
  return entry!.id;
}

/**
 * Credits a paid Stripe Checkout session. Idempotent: a second delivery is a no-op.
 * Returns true when this call did the crediting.
 */
export async function creditTopup(
  db: Database,
  args: { checkoutId: string; paymentIntent: string | null; amountCents: number },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [topup] = await tx.select().from(topups).where(eq(topups.stripeCheckoutId, args.checkoutId)).for("update");
    if (!topup) throw new LedgerError("not_found", `No top-up for checkout ${args.checkoutId}`);
    if (topup.status === "paid" || topup.status === "refunded" || topup.status === "disputed") return false;
    if (args.amountCents !== topup.amountCents) {
      // Never credit more than we asked Stripe to charge.
      throw new LedgerError("invalid", `Checkout ${args.checkoutId} paid ${args.amountCents}, expected ${topup.amountCents}`);
    }
    await tx
      .update(topups)
      .set({ status: "paid", paidAt: new Date(), stripePaymentIntent: args.paymentIntent })
      .where(eq(topups.id, topup.id));
    await tx.insert(walletEntries).values({
      userId: topup.userId,
      deltaCents: topup.amountCents,
      kind: "topup",
      topupId: topup.id,
      note: `Top-up via Stripe`,
    });
    return true;
  });
}

export const TITLE_MIN = 8;
export const TITLE_MAX = 120;
export const BODY_MAX = 4_000;

export function validateIdea(title: string, body: string): { title: string; body: string } {
  const t = title.replace(/\s+/g, " ").trim();
  const b = body.replace(/\r\n/g, "\n").trim();
  if (t.length < TITLE_MIN || t.length > TITLE_MAX) {
    throw new LedgerError("invalid", `Title must be ${TITLE_MIN}–${TITLE_MAX} characters.`);
  }
  if (b.length > BODY_MAX) throw new LedgerError("invalid", `Description must be at most ${BODY_MAX} characters.`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(t + b)) throw new LedgerError("invalid", "Remove control characters.");
  return { title: t, body: b };
}

/** Posts an idea: one credit, which is also the author's first vote. Screening happens after. */
export async function postIdea(db: Database, userId: number, input: { title: string; body: string }) {
  const { title, body } = validateIdea(input.title, input.body);
  return db.transaction(async (tx) => {
    const walletEntryId = await commitCredit(tx, userId, "post", null);
    const [idea] = await tx.insert(ideas).values({ authorId: userId, title, body, voteCount: 1 }).returning();
    await tx.update(walletEntries).set({ ideaId: idea!.id }).where(eq(walletEntries.id, walletEntryId));
    await tx.insert(votes).values({ ideaId: idea!.id, userId, walletEntryId });
    return idea!;
  });
}

/**
 * Screening rejected a new idea: give the poster their credit back and close it.
 * Only for ideas nobody else could have voted on yet (still unscreened).
 */
export async function rejectAndRefundPost(db: Database, ideaId: number, reason: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [idea] = await tx.select().from(ideas).where(eq(ideas.id, ideaId)).for("update");
    if (!idea) throw new LedgerError("not_found", "No such idea.");
    if (idea.status !== "open" || idea.screenVerdict) return;
    const [post] = await tx
      .select()
      .from(walletEntries)
      .where(and(eq(walletEntries.ideaId, ideaId), eq(walletEntries.kind, "post")));
    if (post) {
      const [refund] = await tx
        .insert(walletEntries)
        .values({ userId: post.userId, deltaCents: -post.deltaCents, kind: "refund", ideaId, note: "Idea rejected at screening" })
        .returning({ id: walletEntries.id });
      const shares = await tx.select().from(fundEntries).where(eq(fundEntries.walletEntryId, post.id));
      if (shares.length) {
        await tx.insert(fundEntries).values(
          shares.map((s) => ({
            account: s.account,
            deltaCents: -s.deltaCents,
            kind: "commit" as const,
            walletEntryId: refund!.id,
            note: `Refund of post for idea ${ideaId}`,
          })),
        );
      }
    }
    await tx
      .update(ideas)
      .set({ status: "rejected", rejectedReason: reason, decidedAt: new Date() })
      .where(eq(ideas.id, ideaId));
  });
}

export async function votesByUserOnIdea(db: DbOrTx, userId: number, ideaId: number): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(votes)
    .where(and(eq(votes.ideaId, ideaId), eq(votes.userId, userId)));
  return row?.n ?? 0;
}

/** One credit, one vote, up to the per-idea cap. Only open, screened ideas take votes. */
export async function vote(db: Database, userId: number, ideaId: number): Promise<{ voteCount: number; mine: number }> {
  return db.transaction(async (tx) => {
    const [idea] = await tx.select().from(ideas).where(eq(ideas.id, ideaId)).for("update");
    if (!idea || idea.hiddenAt) throw new LedgerError("not_found", "No such idea.");
    if (idea.status !== "open" || !idea.screenVerdict?.allowed) {
      throw new LedgerError("idea_closed", "This idea isn't taking votes.");
    }
    const mine = await votesByUserOnIdea(tx, userId, ideaId);
    const cap = config.maxVotesPerUserPerIdea;
    if (mine >= cap) throw new LedgerError("vote_cap", `You've put the maximum ${cap} votes on this idea.`);
    const walletEntryId = await commitCredit(tx, userId, "vote", ideaId);
    await tx.insert(votes).values({ ideaId, userId, walletEntryId });
    const [updated] = await tx
      .update(ideas)
      .set({ voteCount: sql`${ideas.voteCount} + 1` })
      .where(eq(ideas.id, ideaId))
      .returning({ voteCount: ideas.voteCount });
    return { voteCount: updated!.voteCount, mine: mine + 1 };
  });
}

/** A build's real spend comes out of the build fund. */
export async function chargeBuild(db: DbOrTx, buildId: number, cents: number, note: string): Promise<void> {
  if (cents <= 0) return;
  await db.insert(fundEntries).values({ account: "build", deltaCents: -cents, kind: "build_spend", buildId, note });
}

/** Admin wallet adjustment (positive or negative), always with a note. */
export async function adjustWallet(db: Database, userId: number, cents: number, note: string): Promise<void> {
  if (!Number.isInteger(cents) || cents === 0) throw new LedgerError("invalid", "Adjustment must be a non-zero whole number of cents.");
  if (!note.trim()) throw new LedgerError("invalid", "Adjustments need a note.");
  await db.transaction(async (tx) => {
    await lockUser(tx, userId);
    await tx.insert(walletEntries).values({ userId, deltaCents: cents, kind: "adjustment", note });
  });
}

export async function hasPaidTopup(db: DbOrTx, userId: number): Promise<boolean> {
  const [row] = await db
    .select({ id: topups.id })
    .from(topups)
    .where(and(eq(topups.userId, userId), eq(topups.status, "paid")))
    .limit(1);
  return Boolean(row);
}

/**
 * A card dispute: mark the top-up, suspend the account pending review, and zero whatever
 * credit is left so it can't be spent. Committed credits stay committed. Idempotent.
 */
export async function handleDispute(db: Database, paymentIntent: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [topup] = await tx.select().from(topups).where(eq(topups.stripePaymentIntent, paymentIntent)).for("update");
    if (!topup || topup.status === "disputed") return false;
    await tx.update(topups).set({ status: "disputed" }).where(eq(topups.id, topup.id));
    await lockUser(tx, topup.userId);
    await tx
      .update(users)
      .set({ bannedAt: new Date(), bannedReason: "Card payment disputed; pending review" })
      .where(eq(users.id, topup.userId));
    await tx.delete(sessions).where(eq(sessions.userId, topup.userId));
    const balance = await walletBalance(tx, topup.userId);
    if (balance > 0) {
      await tx.insert(walletEntries).values({
        userId: topup.userId,
        deltaCents: -balance,
        kind: "adjustment",
        topupId: topup.id,
        note: "Balance frozen: payment disputed",
      });
    }
    return true;
  });
}
