import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { freshDb, fund, hasDb, makeUser } from "../../tests/helpers/db.js";
import type { Database } from "../db/client.js";
import { ideas, topups, users, walletEntries } from "../db/schema.js";
import {
  LedgerError,
  chargeBuild,
  creditTopup,
  fundBalance,
  handleDispute,
  postIdea,
  rejectAndRefundPost,
  splitCredit,
  validateIdea,
  vote,
  walletBalance,
} from "./ledger.js";

describe("splitCredit", () => {
  it("splits 80/20 by default and never loses a cent", () => {
    expect(splitCredit(100, 0.8)).toEqual({ build: 80, hosting: 20 });
    expect(splitCredit(100, 0.75)).toEqual({ build: 75, hosting: 25 });
    expect(splitCredit(100, 1)).toEqual({ build: 100, hosting: 0 });
    for (const share of [0, 0.333, 0.5, 0.81, 0.999]) {
      const s = splitCredit(100, share);
      expect(s.build + s.hosting).toBe(100);
    }
  });
});

describe("validateIdea", () => {
  it("normalises and bounds titles", () => {
    expect(validateIdea("  A   good   idea  ", "")).toEqual({ title: "A good idea", body: "" });
    expect(() => validateIdea("short", "")).toThrow(LedgerError);
    expect(() => validateIdea("x".repeat(121), "")).toThrow(LedgerError);
    expect(() => validateIdea("Valid title", "x".repeat(4001))).toThrow(LedgerError);
    expect(() => validateIdea("Valid title\u0007", "")).toThrow(LedgerError);
  });
});

const screened = { allowed: true, category: "ok", reason: "", model: "test", at: new Date().toISOString() };

describe.skipIf(!hasDb)("ledger (postgres)", () => {
  let db: Database;
  let close: () => Promise<void>;
  beforeAll(async () => ({ db, close } = await freshDb()));
  afterAll(async () => close?.());

  it("posting costs one credit, splits it into the funds, and casts the author's vote", async () => {
    const u = await makeUser(db);
    await fund(db, u.id, 500);
    const buildBefore = await fundBalance(db, "build");
    const idea = await postIdea(db, u.id, { title: "Add a guestbook", body: "Let people sign it." });
    expect(idea.voteCount).toBe(1);
    expect(await walletBalance(db, u.id)).toBe(400);
    expect((await fundBalance(db, "build")) - buildBefore).toBe(80);
  });

  it("refuses to post without credit, and leaves nothing behind", async () => {
    const u = await makeUser(db);
    await expect(postIdea(db, u.id, { title: "Free idea please", body: "" })).rejects.toMatchObject({
      code: "insufficient_funds",
    });
    expect(await db.select().from(ideas).where(eq(ideas.authorId, u.id))).toHaveLength(0);
  });

  it("refunds a post rejected at screening, exactly once", async () => {
    const u = await makeUser(db);
    await fund(db, u.id, 500);
    const build0 = await fundBalance(db, "build");
    const host0 = await fundBalance(db, "hosting");
    const idea = await postIdea(db, u.id, { title: "Something not allowed", body: "" });
    await rejectAndRefundPost(db, idea.id, "Out of policy");
    await rejectAndRefundPost(db, idea.id, "Out of policy");
    expect(await walletBalance(db, u.id)).toBe(500);
    expect(await fundBalance(db, "build")).toBe(build0);
    expect(await fundBalance(db, "hosting")).toBe(host0);
    const [row] = await db.select().from(ideas).where(eq(ideas.id, idea.id));
    expect(row!.status).toBe("rejected");
  });

  it("only screened, open ideas take votes", async () => {
    const author = await makeUser(db);
    await fund(db, author.id, 500);
    const idea = await postIdea(db, author.id, { title: "Unscreened idea", body: "" });
    const voter = await makeUser(db);
    await fund(db, voter.id, 500);
    await expect(vote(db, voter.id, idea.id)).rejects.toMatchObject({ code: "idea_closed" });
    await db.update(ideas).set({ screenVerdict: screened }).where(eq(ideas.id, idea.id));
    await expect(vote(db, voter.id, idea.id)).resolves.toEqual({ voteCount: 2, mine: 1 });
    await db.update(ideas).set({ status: "frozen" }).where(eq(ideas.id, idea.id));
    await expect(vote(db, voter.id, idea.id)).rejects.toMatchObject({ code: "idea_closed" });
  });

  it("caps votes per user per idea at 10", async () => {
    const author = await makeUser(db);
    await fund(db, author.id, 100);
    const idea = await postIdea(db, author.id, { title: "Cap test idea", body: "" });
    await db.update(ideas).set({ screenVerdict: screened }).where(eq(ideas.id, idea.id));
    const whale = await makeUser(db);
    await fund(db, whale.id, 5_000);
    for (let i = 0; i < 10; i++) await vote(db, whale.id, idea.id);
    await expect(vote(db, whale.id, idea.id)).rejects.toMatchObject({ code: "vote_cap" });
    expect(await walletBalance(db, whale.id)).toBe(4_000);
    // The author's post counts as one of theirs.
    for (let i = 0; i < 9; i++) await vote(db, author.id, idea.id).catch(() => {});
    const [row] = await db.select().from(ideas).where(eq(ideas.id, idea.id));
    expect(row!.voteCount).toBe(11);
  });

  it("can't spend the same credit twice under concurrency", async () => {
    const author = await makeUser(db);
    await fund(db, author.id, 100);
    const idea = await postIdea(db, author.id, { title: "Race condition idea", body: "" });
    await db.update(ideas).set({ screenVerdict: screened }).where(eq(ideas.id, idea.id));
    const u = await makeUser(db);
    await fund(db, u.id, 300);
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => vote(db, u.id, idea.id)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    expect(await walletBalance(db, u.id)).toBe(0);
    const [row] = await db.select().from(ideas).where(eq(ideas.id, idea.id));
    expect(row!.voteCount).toBe(4);
  });

  it("banned users can't commit", async () => {
    const u = await makeUser(db, { bannedAt: new Date() });
    await fund(db, u.id, 500);
    await expect(postIdea(db, u.id, { title: "Banned user idea", body: "" })).rejects.toMatchObject({ code: "banned" });
  });

  it("credits a top-up once, and only for the amount asked", async () => {
    const u = await makeUser(db);
    const [t] = await db.insert(topups).values({ userId: u.id, amountCents: 1_000, stripeCheckoutId: "cs_once" }).returning();
    await expect(creditTopup(db, { checkoutId: "cs_once", paymentIntent: "pi_1", amountCents: 999 })).rejects.toMatchObject({
      code: "invalid",
    });
    expect(await creditTopup(db, { checkoutId: "cs_once", paymentIntent: "pi_1", amountCents: 1_000 })).toBe(true);
    expect(await creditTopup(db, { checkoutId: "cs_once", paymentIntent: "pi_1", amountCents: 1_000 })).toBe(false);
    expect(await walletBalance(db, u.id)).toBe(1_000);
    const [row] = await db.select().from(topups).where(eq(topups.id, t!.id));
    expect(row!.status).toBe("paid");
  });

  it("a dispute freezes the balance and suspends the account", async () => {
    const u = await makeUser(db);
    await db.insert(topups).values({ userId: u.id, amountCents: 1_000, stripeCheckoutId: "cs_dispute" });
    await creditTopup(db, { checkoutId: "cs_dispute", paymentIntent: "pi_dispute", amountCents: 1_000 });
    await postIdea(db, u.id, { title: "Spent before dispute", body: "" });
    expect(await handleDispute(db, "pi_dispute")).toBe(true);
    expect(await handleDispute(db, "pi_dispute")).toBe(false);
    expect(await walletBalance(db, u.id)).toBe(0);
    const [row] = await db.select().from(users).where(eq(users.id, u.id));
    expect(row!.bannedAt).not.toBeNull();
    const entries = await db.select().from(walletEntries).where(eq(walletEntries.userId, u.id));
    expect(entries.map((e) => e.kind).sort()).toEqual(["adjustment", "post", "topup"]);
  });

  it("charges builds to the build fund", async () => {
    const before = await fundBalance(db, "build");
    await chargeBuild(db, 1, 421, "test build");
    expect(await fundBalance(db, "build")).toBe(before - 421);
  });
});
