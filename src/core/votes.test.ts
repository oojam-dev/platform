import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { freshDb, hasDb, makeUser } from "../../tests/helpers/db.js";
import type { Database } from "../db/client.js";
import { ideas, votes } from "../db/schema.js";
import { RuleError } from "./errors.js";
import { budgetLeftTodayCents, chargeBuild, chargeScreening, spentSinceCents } from "./spend.js";
import { fundEntries } from "../db/schema.js";
import { listVoters, postIdea, postsToday, rejectAtScreening, unvote, validateIdea, vote, votedOn } from "./votes.js";
import { costSummary } from "./stats.js";
import { recordRefVisit, recordShare, referralSummary, setReferrer, viralStats } from "./referrals.js";

describe("validateIdea", () => {
  it("normalises and bounds titles", () => {
    expect(validateIdea("  A   good   idea  ", "")).toEqual({ title: "A good idea", body: "" });
    expect(() => validateIdea("short", "")).toThrow(RuleError);
    expect(() => validateIdea("x".repeat(121), "")).toThrow(RuleError);
    expect(() => validateIdea("Valid title", "x".repeat(4001))).toThrow(RuleError);
    expect(() => validateIdea("Valid title\u0007", "")).toThrow(RuleError);
  });
});

const screened = { allowed: true, category: "ok", reason: "", model: "test", at: new Date().toISOString() };
const rejected = { allowed: false, category: "illegal", reason: "No.", model: "test", at: new Date().toISOString() };

describe.skipIf(!hasDb)("votes, referrals and spend (postgres)", () => {
  let db: Database;
  let close: () => Promise<void>;
  beforeAll(async () => ({ db, close } = await freshDb()));
  afterAll(async () => close?.());

  async function openIdea(title = "An idea worth voting on") {
    const author = await makeUser(db);
    const idea = await postIdea(db, author.id, { title, body: "" });
    await db.update(ideas).set({ screenVerdict: screened }).where(eq(ideas.id, idea.id));
    return { author, idea };
  }

  it("posting is the author's vote", async () => {
    const { author, idea } = await openIdea("Add a guestbook");
    expect(idea.voteCount).toBe(1);
    expect(await votedOn(db, author.id, [idea.id])).toEqual(new Set([idea.id]));
  });

  it("allows one idea a day; a screening rejection doesn't count", async () => {
    const u = await makeUser(db);
    const first = await postIdea(db, u.id, { title: "First idea today", body: "" });
    await expect(postIdea(db, u.id, { title: "Second idea today", body: "" })).rejects.toMatchObject({ code: "post_limit" });
    await rejectAtScreening(db, first.id, rejected);
    await rejectAtScreening(db, first.id, rejected);
    expect(await postsToday(db, u.id)).toEqual({ attempts: 1, posts: 0 });
    const [row] = await db.select().from(ideas).where(eq(ideas.id, first.id));
    expect(row).toMatchObject({ status: "rejected", voteCount: 0 });
    await expect(postIdea(db, u.id, { title: "A better idea today", body: "" })).resolves.toBeTruthy();
  });

  it("a withdrawn idea frees the day's slot, but still counts as an attempt", async () => {
    const u = await makeUser(db);
    const first = await postIdea(db, u.id, { title: "Changed my mind idea", body: "" });
    await db.update(ideas).set({ status: "withdrawn" }).where(eq(ideas.id, first.id));
    expect(await postsToday(db, u.id)).toEqual({ attempts: 1, posts: 0 });
    await expect(postIdea(db, u.id, { title: "The idea I really want", body: "" })).resolves.toBeTruthy();
  });

  it("caps attempts so rejected posts can't run up the screening bill", async () => {
    const u = await makeUser(db);
    for (let i = 0; i < 3; i++) {
      const idea = await postIdea(db, u.id, { title: `Rejected attempt ${i}`, body: "" });
      await rejectAtScreening(db, idea.id, rejected);
    }
    await expect(postIdea(db, u.id, { title: "Fourth attempt today", body: "" })).rejects.toMatchObject({ code: "post_limit" });
  });

  it("only screened, open ideas take votes", async () => {
    const author = await makeUser(db);
    const idea = await postIdea(db, author.id, { title: "Unscreened idea", body: "" });
    const voter = await makeUser(db);
    await expect(vote(db, voter.id, idea.id)).rejects.toMatchObject({ code: "idea_closed" });
    await db.update(ideas).set({ screenVerdict: screened }).where(eq(ideas.id, idea.id));
    await expect(vote(db, voter.id, idea.id)).resolves.toEqual({ voteCount: 2, voted: true });
    await db.update(ideas).set({ status: "frozen" }).where(eq(ideas.id, idea.id));
    await expect(vote(db, voter.id, idea.id)).rejects.toMatchObject({ code: "idea_closed" });
    await expect(unvote(db, voter.id, idea.id)).rejects.toMatchObject({ code: "idea_closed" });
  });

  it("one vote per account per idea, any number of ideas, and votes can be taken back", async () => {
    const a = await openIdea("One vote idea A");
    const b = await openIdea("One vote idea B");
    const fan = await makeUser(db);
    expect(await vote(db, fan.id, a.idea.id)).toEqual({ voteCount: 2, voted: true });
    expect(await vote(db, fan.id, a.idea.id)).toEqual({ voteCount: 2, voted: true });
    expect(await vote(db, fan.id, b.idea.id)).toEqual({ voteCount: 2, voted: true });
    expect(await unvote(db, fan.id, a.idea.id)).toEqual({ voteCount: 1, voted: false });
    expect(await unvote(db, fan.id, a.idea.id)).toEqual({ voteCount: 1, voted: false });
    expect(await votedOn(db, fan.id, [a.idea.id, b.idea.id])).toEqual(new Set([b.idea.id]));
  });

  it("concurrent double votes still count once", async () => {
    const { idea } = await openIdea("Race idea");
    const u = await makeUser(db);
    await Promise.all(Array.from({ length: 8 }, () => vote(db, u.id, idea.id)));
    const [row] = await db.select().from(ideas).where(eq(ideas.id, idea.id));
    expect(row!.voteCount).toBe(2);
    expect(await db.select().from(votes).where(eq(votes.ideaId, idea.id))).toHaveLength(2);
  });

  it("banned users can't post or vote", async () => {
    const { idea } = await openIdea("Ban test idea");
    const u = await makeUser(db, { bannedAt: new Date() });
    await expect(postIdea(db, u.id, { title: "Banned user idea", body: "" })).rejects.toMatchObject({ code: "banned" });
    await expect(vote(db, u.id, idea.id)).rejects.toMatchObject({ code: "banned" });
  });

  it("tracks who brought voters in, publicly, and computes the viral coefficient", async () => {
    const { author, idea } = await openIdea("Shareable idea");
    await recordShare(db, { ideaId: idea.id, userId: author.id, channel: "x" });
    await recordShare(db, { ideaId: idea.id, userId: author.id, channel: "nonsense" });
    expect(await recordRefVisit(db, { ideaId: idea.id, referrerLogin: author.githubLogin.toUpperCase() })).toBe(author.id);
    expect(await recordRefVisit(db, { ideaId: idea.id, referrerLogin: "no such login!" })).toBeNull();
    const friend = await makeUser(db);
    await setReferrer(db, friend.id, author.githubLogin);
    await setReferrer(db, friend.id, "someone-else");
    await vote(db, friend.id, idea.id, author.id);
    const self = await makeUser(db);
    await setReferrer(db, self.id, self.githubLogin);
    await vote(db, self.id, idea.id, self.id);
    const voters = await listVoters(db, idea.id);
    expect(voters.map((v) => [v.login, v.via])).toEqual([
      [self.githubLogin, null],
      [friend.githubLogin, author.githubLogin],
      [author.githubLogin, null],
    ]);
    expect(await referralSummary(db, idea.id)).toMatchObject({ refVoters: 1, topSharers: [{ login: author.githubLogin, voters: 1 }] });
    const stats = await viralStats(db, 7);
    expect(stats.shares).toMatchObject({ x: 1, other: 1 });
    expect(stats.refVisits).toBe(1);
    expect(stats.refSignups).toBe(1);
    expect(stats.kFactor).toBeGreaterThan(0);
  });

  it("caps spend per UTC day, across builds and screening", async () => {
    const yesterday = new Date(Date.now() - 86_400_000);
    await db.insert(fundEntries).values({ deltaCents: -900, kind: "build_spend", buildId: 99, note: "yesterday", createdAt: yesterday });
    expect(await budgetLeftTodayCents(db)).toBe(1_000);
    await chargeBuild(db, 1, 640, "today's build");
    await chargeScreening(db, 35, "an idea");
    expect(await budgetLeftTodayCents(db)).toBe(325);
    await chargeBuild(db, 1, 900, "over budget");
    expect(await budgetLeftTodayCents(db)).toBe(0);
    expect(await spentSinceCents(db, new Date(Date.now() - 2 * 86_400_000))).toBe(900 + 640 + 35 + 900);
    const summary = await costSummary(db);
    expect(summary).toMatchObject({ dailyBudgetCents: 1_000, todayCents: 640 + 35 + 900, allTimeCents: 900 + 640 + 35 + 900, screeningCents: 35 });
  });
});
