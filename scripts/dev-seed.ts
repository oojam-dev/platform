/**
 * Seeds a local development database with users, ideas, votes (some through share links),
 * shares, comments, fund contributions and a few builds, going through src/core wherever it
 * can. It WIPES the database first, so it refuses to run against anything that doesn't look
 * like a local dev database.
 *
 *   DATABASE_URL=postgres://postgres@localhost:55434/oojam_dev npx tsx scripts/dev-seed.ts
 *
 * Prints session tokens: set one as the `oojam_session` cookie on localhost to sign in.
 */
import { eq, sql } from "drizzle-orm";

import { hideComment } from "../src/core/admin.js";
import { createSession } from "../src/core/auth.js";
import { addComment } from "../src/core/ideas.js";
import { chargeBuild, chargeScreening } from "../src/core/spend.js";
import { recordRefVisit, recordShare, setReferrer } from "../src/core/referrals.js";
import { postIdea, rejectAtScreening, vote } from "../src/core/votes.js";
import { closeDb, getDb } from "../src/db/client.js";
import { builds, deployments, ideas, users, votes, type BuildLogEntry, type ScreenVerdict } from "../src/db/schema.js";

const url = process.env.DATABASE_URL ?? "";
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(url) || !/dev/.test(url)) {
  console.error("dev-seed: refusing to wipe a database that isn't a local *dev* database:", url.replace(/:[^:@/]+@/, ":***@"));
  process.exit(1);
}
process.env.SESSION_SECRET ??= "dev";

const db = getDb();

async function reset() {
  const rows = await db.execute<{ tablename: string }>(sql`select tablename from pg_tables where schemaname = 'public'`);
  const names = [...rows].map((r) => `"${r.tablename}"`).filter((n) => n !== '"__drizzle_migrations"');
  if (names.length) await db.execute(sql.raw(`truncate table ${names.join(", ")} restart identity cascade`));
}

const daysAgo = (n: number, h = 0) => new Date(Date.now() - n * 86_400_000 - h * 3_600_000);

async function user(githubId: number, login: string, opts: { admin?: boolean; avatar?: boolean; name?: string; joined?: number } = {}) {
  const [u] = await db
    .insert(users)
    .values({
      githubId,
      githubLogin: login,
      name: opts.name ?? null,
      avatarUrl: opts.avatar ? `https://avatars.githubusercontent.com/u/${githubId}?v=4` : null,
      githubCreatedAt: daysAgo(900),
      isAdmin: Boolean(opts.admin),
      createdAt: daysAgo(opts.joined ?? 10),
    })
    .returning();
  return u!;
}

const allowed = (): ScreenVerdict => ({
  allowed: true,
  category: "ok",
  reason: "Harmless and buildable in a day.",
  model: "claude-opus-5-5",
  at: new Date().toISOString(),
});

/** Posts through core (one a day per author), then backdates it so the author can post again. */
async function idea(authorId: number, title: string, body: string, createdDaysAgo: number, screened = true) {
  const i = await postIdea(db, authorId, { title, body });
  const at = daysAgo(createdDaysAgo, 3);
  await db
    .update(ideas)
    .set({ createdAt: at, ...(screened ? { screenVerdict: allowed() } : {}) })
    .where(eq(ideas.id, i.id));
  await db.update(votes).set({ createdAt: at }).where(eq(votes.ideaId, i.id));
  return i;
}

async function main() {
  await reset();

  const octo = await user(583231, "octocat", { admin: true, avatar: true, name: "The Octocat", joined: 40 });
  const jam = await user(9001, "jamfan", { name: "Jam Fan", joined: 30 });
  const pix = await user(9002, "pixelpusher", { joined: 25 });
  const owl = await user(9003, "nightowl", { joined: 20 });
  const newbie = await user(9004, "newbie", { joined: 1 });
  const crowd = [];
  for (const [i, login] of ["mossy", "kettle", "ferngully", "tinsel", "quokka", "harbour", "zinnia", "brambles", "lumen", "pebble"].entries()) {
    crowd.push(await user(9100 + i, login, { joined: 2 + i }));
  }

  // Share-driven sign-ups: jamfan's link brought in a few people.
  for (const u of [newbie, crowd[0]!, crowd[1]!, crowd[2]!]) await setReferrer(db, u.id, "jamfan");
  await setReferrer(db, crowd[3]!.id, "pixelpusher");

  // A deployed idea, a failed one, and the open board.
  const built = await idea(
    pix.id,
    "A guestbook where every entry has to be a haiku",
    "Visitors leave a 5-7-5 haiku. The page counts syllables as you type and refuses anything that doesn't scan.\n\n- 280 characters max\n- Report button hides an entry after 3 reports",
    6,
  );
  for (const u of [jam, owl, octo, crowd[4]!, crowd[5]!, crowd[6]!]) await vote(db, u.id, built.id);

  const failedIdea = await idea(owl.id, "Make the whole site render in Comic Sans on Fridays", "Only on Fridays (UTC). Every other day stays as it is.", 5);
  for (const u of [pix, crowd[7]!]) await vote(db, u.id, failedIdea.id);

  const top = await idea(
    jam.id,
    "A pixel canvas everyone paints together, one pixel per minute",
    "A 64×64 canvas. Each visitor can place **one pixel per minute** (per IP). A tiny palette of 16 colours.\n\nShow a timelapse of the day's canvas at midnight.\n\nInspired by [r/place](https://en.wikipedia.org/wiki/R/place).",
    3,
  );
  await vote(db, octo.id, top.id);
  await vote(db, pix.id, top.id);
  await vote(db, owl.id, top.id, jam.id);
  for (const u of crowd.slice(0, 7)) await vote(db, u.id, top.id, u === crowd[3] ? pix.id : jam.id);
  await vote(db, newbie.id, top.id, jam.id);

  const second = await idea(
    octo.id,
    "Show today's build on the homepage as a live ticker",
    "A thin ticker at the top of oojam.dev saying what was built last night and linking to the PR.",
    2,
  );
  for (const u of [owl, jam, crowd[8]!]) await vote(db, u.id, second.id);
  await vote(db, crowd[9]!.id, second.id, octo.id);

  const third = await idea(pix.id, "A dark mode toggle that remembers your choice", "", 1);
  for (const u of [octo, crowd[1]!]) await vote(db, u.id, third.id);

  await idea(
    owl.id,
    "An ASCII aquarium in the footer",
    "Little fish `><>` swim across the footer. Clicking one feeds it.\n\n```\n  ><>     <><\n      ><>\n```",
    0,
  );

  // Posted today, not screened yet (the screener was unavailable).
  await postIdea(db, jam.id, { title: "Random compliment generator for visitors", body: "One button, one compliment." });

  // Rejected at screening today (the author gets their vote back).
  const rejected = await postIdea(db, pix.id, { title: "Track every visitor's location on a map", body: "Use their IP address." });
  await rejectAtScreening(db, rejected.id, {
    allowed: false,
    category: "malicious",
    reason: "Tracking visitors' locations breaks the tracking and personal-data rules.",
    model: "claude-opus-5-5",
    at: new Date().toISOString(),
  });

  // Shares and visits through links.
  const shareLog: [number, number | null, string][] = [
    [top.id, jam.id, "x"],
    [top.id, jam.id, "copy"],
    [top.id, jam.id, "bluesky"],
    [top.id, pix.id, "hackernews"],
    [top.id, null, "copy"],
    [second.id, octo.id, "linkedin"],
    [second.id, octo.id, "native"],
    [built.id, pix.id, "reddit"],
    [third.id, pix.id, "email"],
  ];
  for (const [ideaId, userId, channel] of shareLog) await recordShare(db, { ideaId, userId, channel });
  for (let i = 0; i < 23; i++) await recordRefVisit(db, { ideaId: top.id, referrerLogin: i % 5 === 0 ? "pixelpusher" : "jamfan" });
  for (let i = 0; i < 6; i++) await recordRefVisit(db, { ideaId: second.id, referrerLogin: "octocat" });

  // The fund: contributions in, builds and screening out.
  for (let i = 0; i < 9; i++) await chargeScreening(db, 3, `Screening idea ${i + 1}`);

  const log = (start: Date, steps: [string, string][]): BuildLogEntry[] =>
    steps.map(([step, message], i) => ({ at: new Date(start.getTime() + i * 7 * 60_000).toISOString(), step, message }));
  const day = (n: number) => daysAgo(n).toISOString().slice(0, 10);

  await db.insert(builds).values({
    day: day(4),
    status: "skipped",
    error: "The build fund held $2.40, below the $3.00 minimum. The top idea stays on the board.",
    log: log(daysAgo(4), [["freeze", "Fund below minimum; skipping today."]]),
    createdAt: daysAgo(4),
  });

  const [failedBuild] = await db
    .insert(builds)
    .values({
      day: day(3),
      ideaId: failedIdea.id,
      status: "failed",
      attempt: 2,
      budgetCents: 640,
      costCents: 512,
      error: "Both attempts failed the gate: the change rewrote existing global styles that other builds depend on.",
      gateReport:
        "## Gate report — attempt 2\n\n| Check | Result |\n|---|---|\n| Protected paths | pass |\n| Migrations | pass |\n| Dependencies | pass |\n| Review | **block** |\n\n**block** `app/app.css:1` — replaces the site's base font stack every day, not only Fridays.",
      log: log(daysAgo(3), [
        ["freeze", "Froze “Make the whole site render in Comic Sans on Fridays” with 3 votes."],
        ["screen", "Pre-build screen passed."],
        ["build", "Attempt 1 started with a $6.40 budget."],
        ["gate", "Attempt 1 blocked by review: change is not limited to Fridays."],
        ["build", "Attempt 2 started with gate feedback."],
        ["gate", "Attempt 2 blocked by review."],
        ["failed", "Giving up after 2 attempts."],
      ]),
      startedAt: daysAgo(3),
      finishedAt: new Date(daysAgo(3).getTime() + 50 * 60_000),
      createdAt: daysAgo(3),
    })
    .returning();
  await chargeBuild(db, failedBuild!.id, 512, "Build spend (2 attempts)");
  await db.update(ideas).set({ status: "failed", frozenAt: daysAgo(3), decidedAt: daysAgo(3) }).where(eq(ideas.id, failedIdea.id));

  const [okBuild] = await db
    .insert(builds)
    .values({
      day: day(1),
      ideaId: built.id,
      status: "deployed",
      attempt: 1,
      budgetCents: 860,
      costCents: 437,
      branch: "build/haiku-guestbook",
      prNumber: 42,
      prUrl: "https://github.com/oojam/oojam/pull/42",
      mergeSha: "3f9c2a7e1b4d8c6f0a2e5b7d9c1f3a5e7b9d2c4f",
      summary:
        "Added a **haiku guestbook** at `/guestbook`.\n\n- Live syllable counter (client-side, dictionary + heuristic)\n- Entries limited to 280 characters, escaped on render\n- Per-IP rate limit of 3 entries per hour\n- Report button; 3 reports hides an entry\n- New table `guestbook_entries` (additive migration)",
      gateReport:
        "## Gate report — attempt 1\n\nAll checks passed.\n\n- Protected paths: pass\n- Migration lint: pass (`CREATE TABLE guestbook_entries`)\n- Dependencies: no changes\n- Secrets: none found\n- Static patterns: 0 block, 0 warn\n- Build & smoke: pass (3 routes)\n- Review: **pass**, matches idea",
      log: log(daysAgo(1), [
        ["freeze", "Froze “A guestbook where every entry has to be a haiku” with 7 votes."],
        ["screen", "Pre-build screen passed."],
        ["build", "Attempt 1 started with an $8.60 budget."],
        ["gate", "All checks passed."],
        ["pr", "Opened oojam/oojam#42."],
        ["ci", "Required checks passed."],
        ["merge", "Squash-merged as 3f9c2a7."],
        ["deploy", "Promoted oojam-site-3f9c2a7e1b4d; health check OK."],
      ]),
      startedAt: daysAgo(1),
      finishedAt: new Date(daysAgo(1).getTime() + 56 * 60_000),
      createdAt: daysAgo(1),
    })
    .returning();
  await chargeBuild(db, okBuild!.id, 437, "Build spend (1 attempt)");
  await db.update(ideas).set({ status: "deployed", frozenAt: daysAgo(1), decidedAt: daysAgo(1, -1) }).where(eq(ideas.id, built.id));

  await db.insert(deployments).values([
    { sha: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678", container: "oojam-site-a1b2c3d4e5f6", status: "retired", createdAt: daysAgo(8), promotedAt: daysAgo(8) },
    {
      buildId: okBuild!.id,
      sha: "3f9c2a7e1b4d8c6f0a2e5b7d9c1f3a5e7b9d2c4f",
      container: "oojam-site-3f9c2a7e1b4d",
      status: "live",
      createdAt: daysAgo(1),
      promotedAt: daysAgo(1),
    },
  ]);

  // Comments.
  await addComment(db, jam.id, top.id, "Could the timelapse be downloadable as a GIF?\nWould love to keep them.");
  await addComment(db, pix.id, top.id, "One pixel per minute feels right. Any faster and it's a bot war.");
  const spam = await addComment(db, owl.id, top.id, "first!!!");
  await hideComment(db, octo.id, spam.id, "Low-effort spam");
  await addComment(db, owl.id, built.id, "Tried it. My haiku about cheese was rejected for 6 syllables. Fair.");

  // Sessions to sign in with.
  const sessions: Record<string, string> = {};
  for (const u of [octo, jam, newbie]) sessions[u.githubLogin] = (await createSession(db, u.id)).token;

  console.log("dev-seed: done.\nSet the `oojam_session` cookie on localhost to one of:");
  for (const [login, token] of Object.entries(sessions)) console.log(`  ${login.padEnd(10)} ${token}`);
}

try {
  await main();
} finally {
  await closeDb();
}
