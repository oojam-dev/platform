/**
 * The daily cycle (SPEC §2.3). A state machine over the day's `builds` row, so a worker that
 * restarts mid-cycle picks up where it left off. Every step is logged on the build page.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { and, eq, sql } from "drizzle-orm";

import { config } from "../core/config.js";
import { audit, getPaused } from "../core/controls.js";
import { topOpenIdea } from "../core/ideas.js";
import { budgetLeftTodayCents, chargeBuild } from "../core/spend.js";
import { usdToCents } from "../core/pricing.js";
import { screenIdea } from "../core/screen.js";
import { utcDay } from "../core/time.js";
import type { Database } from "../db/client.js";
import { builds, ideas, users, type BuildProgress, type BuildStatus } from "../db/schema.js";
import { commitWorkTree } from "../guardrails/git.js";
import { newBuildToken, registerToken, revokeToken, runAttempt } from "./builder-run.js";
import { DeployError, deploySite } from "./deployer.js";
import { runGate } from "./gate.js";
import {
  branchHead,
  closePullRequest,
  coAuthorTrailer,
  commentOnPullRequest,
  openPullRequest,
  squashMerge,
  waitForChecks,
} from "./github.js";
import { buildDirs, cleanupBuild, commitPlatformFile, freshCheckout, pushBranch, resetWorkTree } from "./workspace.js";
import { revertOnMain } from "./revert.js";

type Build = typeof builds.$inferSelect;

/** What a build works on: a community idea, or housekeeping on a day without one. */
interface Task {
  housekeeping: boolean;
  idea: { id: number; title: string; body: string };
  author: { login: string; githubId: number | null };
}

const HOUSEKEEPING: Task = {
  housekeeping: true,
  idea: {
    id: 0,
    title: "Housekeeping",
    body: "No idea was on the board today. Make one small, safe improvement to what's already on oojam.dev: a bug fix, an accessibility or mobile-layout fix, a performance win, or missing tests. No new features, nothing removed, no redesign.",
  },
  author: { login: "oojam-dev", githubId: null },
};

async function loadTask(db: Database, b: Build): Promise<Task | undefined> {
  if (b.ideaId === null) return HOUSEKEEPING;
  const [row] = await db
    .select({ idea: ideas, login: users.githubLogin, githubId: users.githubId })
    .from(ideas)
    .innerJoin(users, eq(users.id, ideas.authorId))
    .where(eq(ideas.id, b.ideaId));
  return row ? { housekeeping: false, idea: row.idea, author: { login: row.login, githubId: row.githubId } } : undefined;
}
const MAX_ATTEMPTS = 2;
const MAX_PREBUILD_REJECTIONS = 3;
const SCREENING_RESERVE_CENTS = 50;

export async function appendLog(db: Database, buildId: number, step: string, message: string): Promise<void> {
  const entry = { at: new Date().toISOString(), step, message: message.slice(0, 4000) };
  console.log(`build ${buildId} [${step}] ${message.split("\n")[0]}`);
  await db
    .update(builds)
    .set({ log: sql`${builds.log} || ${JSON.stringify([entry])}::jsonb` })
    .where(eq(builds.id, buildId));
}

/** Replaces the live progress note, only while the attempt it belongs to is still running. */
async function saveProgress(db: Database, buildId: number, progress: BuildProgress): Promise<void> {
  await db
    .update(builds)
    .set({ progress })
    .where(and(eq(builds.id, buildId), eq(builds.status, "building"), eq(builds.attempt, progress.attempt)));
}

async function setStatus(db: Database, id: number, status: BuildStatus, extra: Partial<Build> = {}): Promise<Build> {
  const [b] = await db.update(builds).set({ status, ...extra }).where(eq(builds.id, id)).returning();
  return b!;
}

async function addCost(db: Database, b: Build, usd: number, what: string): Promise<Build> {
  const cents = usdToCents(usd);
  if (cents <= 0) return b;
  await chargeBuild(db, b.id, cents, `${what} (build ${b.id})`);
  const [nb] = await db.update(builds).set({ costCents: sql`${builds.costCents} + ${cents}` }).where(eq(builds.id, b.id)).returning();
  return nb!;
}

async function finish(db: Database, b: Build, status: BuildStatus, ideaStatus: "deployed" | "failed" | "open" | null, error?: string): Promise<Build> {
  const done = await setStatus(db, b.id, status, { finishedAt: new Date(), error: error ?? b.error, activeToken: null, progress: null });
  if (b.ideaId && ideaStatus) {
    await db
      .update(ideas)
      .set(ideaStatus === "open" ? { status: "open", frozenAt: null } : { status: ideaStatus, decidedAt: new Date(), ...(error ? { rejectedReason: error.slice(0, 500) } : {}) })
      .where(eq(ideas.id, b.ideaId));
  }
  await appendLog(db, b.id, status, error ?? `Finished: ${status}`);
  if (status !== "pr_open") cleanupBuild(b.id);
  return done;
}

/** Runs (or resumes) the cycle for a UTC day. Safe to call repeatedly. */
export async function runCycle(db: Database, day = utcDay()): Promise<Build | undefined> {
  const paused = await getPaused(db);
  if (paused.paused) {
    console.log(`cycle: paused (${paused.reason}); not running ${day}`);
    return undefined;
  }
  await db.insert(builds).values({ day }).onConflictDoNothing();
  let [b] = await db.select().from(builds).where(eq(builds.day, day));
  if (!b) return undefined;
  if (!b.startedAt) b = await setStatus(db, b.id, b.status, { startedAt: new Date() });

  for (let guard = 0; guard < 20; guard++) {
    if ((await getPaused(db)).paused && ["queued", "screening", "building", "gating"].includes(b.status)) {
      await appendLog(db, b.id, "paused", "The system was paused; stopping here. It resumes when unpaused.");
      return b;
    }
    switch (b.status) {
      case "queued":
        b = await stepFreeze(db, b);
        break;
      case "screening":
        b = await stepScreen(db, b);
        break;
      case "building":
      case "gating":
        b = await stepBuild(db, b);
        break;
      case "pr_open":
      case "merging":
        b = await stepMerge(db, b);
        break;
      case "deploying":
        b = await stepDeploy(db, b);
        break;
      default:
        return b; // deployed, failed, rolled_back, skipped
    }
  }
  return b;
}

async function stepFreeze(db: Database, b: Build): Promise<Build> {
  const idea = await topOpenIdea(db, b.skippedIdeaIds);
  // Leave a little of the day's budget for screening ideas posted later today.
  const budgetCents = (await budgetLeftTodayCents(db)) - SCREENING_RESERVE_CENTS;
  if (budgetCents < config.buildBudgetMinUsd * 100) {
    return finish(db, b, "skipped", null, `Only $${(budgetCents / 100).toFixed(2)} of today's $${config.dailyBudgetUsd} budget is free for building, under the $${config.buildBudgetMinUsd} a build needs.${idea ? " The idea stays at the top for tomorrow." : ""}`);
  }
  if (!idea) {
    // No idea today: one small housekeeping improvement instead, through the same gates.
    const nb = await setStatus(db, b.id, "building", { ideaId: null, budgetCents, attempt: 0 });
    await appendLog(db, b.id, "freeze", `No ideas on the board today, so it's a housekeeping day: one small fix or improvement. Budget $${(budgetCents / 100).toFixed(2)}.`);
    return nb;
  }
  await db.update(ideas).set({ status: "frozen", frozenAt: new Date() }).where(eq(ideas.id, idea.id));
  await audit(db, null, "freeze", `idea:${idea.id}`, { day: b.day, votes: idea.voteCount });
  const nb = await setStatus(db, b.id, "screening", { ideaId: idea.id, budgetCents });
  await appendLog(db, b.id, "freeze", `Froze idea #${idea.id} "${idea.title}" with ${idea.voteCount} votes. Budget $${(budgetCents / 100).toFixed(2)}.`);
  return nb;
}

function siteContext(workTree: string): string {
  try {
    const entries = JSON.parse(readFileSync(join(workTree, "content/builds.json"), "utf8")) as { day: string; title: string }[];
    return entries.length ? entries.map((e) => `- ${e.day}: ${e.title}`).join("\n") : "Nothing has been built yet.";
  } catch {
    return "Unknown.";
  }
}

async function stepScreen(db: Database, b: Build): Promise<Build> {
  const [idea] = await db.select().from(ideas).where(eq(ideas.id, b.ideaId!));
  const { dirs, baseSha } = await freshCheckout(b.id);
  const { verdict, costUsd } = await screenIdea(idea!, { context: siteContext(dirs.workTree) });
  b = await addCost(db, b, costUsd, "Pre-build screening");
  if (verdict.allowed) {
    await appendLog(db, b.id, "screen", "Passed the pre-build screen.");
    await db.update(ideas).set({ status: "building" }).where(eq(ideas.id, idea!.id));
    return setStatus(db, b.id, "building", { baseSha, attempt: 0 });
  }
  await db.update(ideas).set({ status: "rejected", rejectedReason: verdict.reason, decidedAt: new Date(), screenVerdict: verdict }).where(eq(ideas.id, idea!.id));
  await audit(db, null, "prebuild_reject", `idea:${idea!.id}`, { reason: verdict.reason, category: verdict.category });
  await appendLog(db, b.id, "screen", `Idea #${idea!.id} rejected at the pre-build screen: ${verdict.reason}`);
  const skipped = [...b.skippedIdeaIds, idea!.id];
  if (skipped.length >= MAX_PREBUILD_REJECTIONS) {
    return finish(db, { ...b, ideaId: null }, "skipped", null, "Several top ideas failed the pre-build screen; no build today.");
  }
  return setStatus(db, b.id, "queued", { ideaId: null, skippedIdeaIds: skipped });
}

function remainingUsd(b: Build): number {
  return (b.budgetCents - b.costCents) / 100;
}

async function stepBuild(db: Database, b: Build): Promise<Build> {
  const task = await loadTask(db, b);
  if (!task) return finish(db, b, "failed", null, "The idea disappeared.");
  const ideaOutcome = (s: "failed" | "open") => (task.housekeeping ? null : s);
  // A restart mid-attempt: meter what that attempt spent, then start it again cleanly.
  if (b.activeToken) {
    b = await addCost(db, b, await revokeToken(b.activeToken), `Attempt ${b.attempt} (interrupted)`);
    b = await setStatus(db, b.id, "building", { activeToken: null, progress: null });
  }
  let dirs = buildDirs(b.id);
  let baseSha = b.baseSha;
  if (!baseSha || b.attempt === 0) {
    const fresh = await freshCheckout(b.id);
    dirs = fresh.dirs;
    baseSha = fresh.baseSha;
    b = await setStatus(db, b.id, "building", { baseSha });
  }
  let feedback: string | null = b.gateReport;
  while (b.attempt < MAX_ATTEMPTS) {
    const attempt = b.attempt + 1;
    const reviewReserve = Math.min(5, remainingUsd(b) * 0.25);
    const budgetUsd = Math.max(0, remainingUsd(b) - reviewReserve);
    if (budgetUsd < 1) return finish(db, b, "failed", ideaOutcome("failed"), feedback ? "The change couldn't pass the guardrails within the budget." : "The budget ran out before building.");
    if (attempt === 1) await resetWorkTree(dirs, baseSha!);
    const token = newBuildToken();
    await registerToken(token, budgetUsd, `build ${b.id} attempt ${attempt}`);
    b = await setStatus(db, b.id, "building", { attempt, activeToken: token, progress: null });
    await appendLog(db, b.id, "build", `Attempt ${attempt}: the builder is working (budget $${budgetUsd.toFixed(2)}, model ${config.buildModel}).`);
    const result = await runAttempt(
      dirs,
      { buildId: b.id, attempt, budgetUsd, idea: { id: task.idea.id, title: task.idea.title, body: task.idea.body, author: task.author.login }, feedback },
      token,
      (p) => saveProgress(db, b.id, p),
    );
    b = await setStatus(db, b.id, "gating", { activeToken: null, progress: null, summary: result.summary || b.summary });
    b = await addCost(db, b, result.costUsd, `Builder attempt ${attempt}`);
    await appendLog(db, b.id, "build", `Attempt ${attempt} ${result.status}; $${result.costUsd.toFixed(2)} spent.${result.error ? ` ${result.error}` : ""}`);
    if (result.status === "gave_up") {
      return task.housekeeping
        ? finish(db, b, "skipped", null, `Housekeeping: nothing needed doing (${result.summary.slice(0, 300)}).`)
        : finish(db, b, "failed", "failed", `The builder couldn't build this within oojam's rules: ${result.summary}`);
    }
    if (result.status === "error" && !result.summary) {
      feedback = `The previous attempt didn't finish: ${result.error ?? "unknown error"}. Log tail:\n${result.logTail}`;
      b = await setStatus(db, b.id, "building", { gateReport: feedback });
      continue;
    }
    const headSha = await commitWorkTree(dirs, task.housekeeping ? "Housekeeping\n\nA small improvement by oojam's daily builder on a day with no idea." : `${task.idea.title}\n\nBuilt by oojam's daily builder for idea #${task.idea.id}.`);
    if (!headSha) {
      feedback = "The previous attempt made no changes.";
      b = await setStatus(db, b.id, "building", { gateReport: feedback });
      continue;
    }
    const gate = await runGate({
      buildId: b.id,
      dirs,
      baseSha: baseSha!,
      headSha,
      idea: task.idea,
      routes: result.routes,
      reviewBudgetUsd: Math.max(1, Math.min(8, remainingUsd(b))),
      log: (step, message) => appendLog(db, b.id, step, message),
    });
    b = await addCost(db, b, gate.reviewCostUsd, "Independent review");
    b = await setStatus(db, b.id, "gating", { gateReport: gate.report });
    if (gate.passed) return openPr(db, b, dirs, headSha, task);
    await appendLog(db, b.id, "gate", `Attempt ${attempt} was blocked by the guardrails.`);
    feedback = gate.report;
  }
  return finish(db, b, "failed", ideaOutcome("failed"), "The change didn't pass oojam's guardrails after two attempts. See the gate report.");
}

interface BuildEntry {
  day: string;
  /** null for housekeeping days. */
  ideaId: number | null;
  title: string;
  author: string;
  prUrl: string;
  summary: string;
}

/** A PR title for the task; housekeeping is titled after what it fixed. */
function prTitle(task: Task, summary: string | null): string {
  if (!task.housekeeping) return task.idea.title;
  const first = (summary ?? "").split("\n").map((l) => l.replace(/^[#>*\-\s]+/, "").trim()).find(Boolean) ?? "a small improvement";
  return `Housekeeping: ${first.length > 90 ? `${first.slice(0, 89)}…` : first}`;
}

async function openPr(db: Database, b: Build, dirs: ReturnType<typeof buildDirs>, builderSha: string, task: Task): Promise<Build> {
  if (config.dryRun) {
    await appendLog(db, b.id, "pr", "Dry run: the change passed every gate. Not opening a PR.");
    return finish(db, b, "skipped", task.housekeeping ? null : "open", "Dry run complete.");
  }
  const idea = task.idea;
  const title = prTitle(task, b.summary);
  const branch = task.housekeeping ? `build/${b.day}-housekeeping` : `build/${b.day}-idea-${idea.id}`;
  // Push the builder's commit first so the PR exists; then add the changelog entry, which needs the PR URL.
  await pushBranch(dirs, builderSha, branch);
  const firstLine = (b.summary ?? "").split("\n").find((l) => l.trim()) ?? idea.title;
  const intro = task.housekeeping
    ? `No idea was on the board on ${b.day}, so oojam's daily builder made one small improvement instead.`
    : `Idea #${idea.id} by @${task.author.login}, built by oojam's daily builder on ${b.day}.\n${idea.body ? `\n> ${idea.body.slice(0, 2000).replace(/\n/g, "\n> ")}\n` : ""}`;
  const body = `## ${title}

${intro}
### What was built
${b.summary || "(no summary)"}

### Guardrails
${b.gateReport ?? ""}

Cost so far: $${(b.costCents / 100).toFixed(2)} of a $${(b.budgetCents / 100).toFixed(2)} budget · [build page](${config.platformUrl}/builds/${b.id})

This PR is merged automatically when CI passes.`;
  const pr = await openPullRequest({ branch, title, body: body.slice(0, 60_000) });
  const entries = JSON.parse(readFileSync(join(dirs.workTree, "content/builds.json"), "utf8")) as BuildEntry[];
  entries.push({
    day: b.day,
    ideaId: task.housekeeping ? null : idea.id,
    title,
    author: task.author.login,
    prUrl: pr.html_url,
    summary: firstLine.replace(/^#+\s*/, "").slice(0, 280),
  });
  const head = await commitPlatformFile(dirs, "content/builds.json", `${JSON.stringify(entries, null, 2)}\n`, `Add ${b.day} to the changelog`);
  await pushBranch(dirs, head, branch);
  await appendLog(db, b.id, "pr", `Opened ${pr.html_url}`);
  return setStatus(db, b.id, "pr_open", { branch, prNumber: pr.number, prUrl: pr.html_url });
}

async function stepMerge(db: Database, b: Build): Promise<Build> {
  const task = await loadTask(db, b);
  if (!task) return finish(db, b, "failed", null, "The idea disappeared.");
  const outcome = task.housekeeping ? null : ("failed" as const);
  const { gh } = await import("./github.js");
  const pr = await gh<{ head: { sha: string }; merged: boolean; merge_commit_sha: string | null; state: string }>("GET", `/repos/${config.siteRepo}/pulls/${b.prNumber}`);
  if (pr.merged && pr.merge_commit_sha) return setStatus(db, b.id, "deploying", { mergeSha: pr.merge_commit_sha });
  if (pr.state !== "open") return finish(db, b, "failed", outcome, "The PR was closed before it could be merged.");
  // Wait on the branch's real head: we push twice (the build, then the changelog), CI cancels the
  // first run, and the PR's head can still show the first commit for a moment after the second push.
  const headSha = await branchHead(b.branch!);
  await appendLog(db, b.id, "ci", `Waiting for CI on ${headSha.slice(0, 12)}`);
  const checks = await waitForChecks(headSha, 45 * 60_000);
  if (checks.failures.length) {
    await commentOnPullRequest(b.prNumber!, `CI failed, so this build won't be merged:\n${checks.failures.map((f) => `- ${f}`).join("\n")}`).catch(() => {});
    await closePullRequest(b.prNumber!).catch(() => {});
    return finish(db, b, "failed", outcome, `CI failed: ${checks.failures.join("; ")}`);
  }
  if ((await getPaused(db)).paused) {
    await appendLog(db, b.id, "paused", "CI passed, but the system is paused; the merge waits.");
    return b;
  }
  await setStatus(db, b.id, "merging");
  const message = task.housekeeping
    ? `Housekeeping on ${b.day}. ${config.platformUrl}/builds/${b.id}`
    : `Idea #${task.idea.id}, built on ${b.day}. ${config.platformUrl}/builds/${b.id}\n\n${coAuthorTrailer(task.author.githubId!, task.author.login)}`;
  const mergeSha = await squashMerge(b.prNumber!, headSha, `${prTitle(task, b.summary)} (#${b.prNumber})`, message);
  await appendLog(db, b.id, "merge", `Merged as ${mergeSha.slice(0, 12)}`);
  return setStatus(db, b.id, "deploying", { mergeSha });
}

async function stepDeploy(db: Database, b: Build): Promise<Build> {
  try {
    await deploySite(db, b.mergeSha!, b.id, (m) => appendLog(db, b.id, "deploy", m));
    await audit(db, null, "deploy", `build:${b.id}`, { sha: b.mergeSha });
    return finish(db, b, "deployed", "deployed");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await appendLog(db, b.id, "deploy", `Deploy failed: ${message}`);
    if (error instanceof DeployError) {
      try {
        const url = await revertOnMain(b.mergeSha!, `Revert build ${b.day}: deploy failed`, message);
        await appendLog(db, b.id, "revert", `Reverted on main: ${url}`);
      } catch (revertError) {
        await appendLog(db, b.id, "revert", `Couldn't revert automatically; a maintainer must revert ${b.mergeSha}: ${revertError}`);
        await audit(db, null, "revert_failed", `build:${b.id}`, { sha: b.mergeSha });
      }
      return finish(db, b, "rolled_back", "failed", message);
    }
    throw error;
  }
}
