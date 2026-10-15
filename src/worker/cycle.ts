/**
 * The daily cycle (SPEC §2.3). A state machine over the day's `builds` row, so a worker that
 * restarts mid-cycle picks up where it left off. Every step is logged on the build page.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { eq, sql } from "drizzle-orm";

import { config } from "../core/config.js";
import { audit, getPaused } from "../core/controls.js";
import { topOpenIdea } from "../core/ideas.js";
import { chargeBuild, fundBalance } from "../core/ledger.js";
import { usdToCents } from "../core/pricing.js";
import { screenIdea } from "../core/screen.js";
import { utcDay } from "../core/time.js";
import type { Database } from "../db/client.js";
import { builds, fundEntries, ideas, users, type BuildStatus } from "../db/schema.js";
import { commitWorkTree } from "../guardrails/git.js";
import { newBuildToken, registerToken, revokeToken, runAttempt } from "./builder-run.js";
import { DeployError, deploySite } from "./deployer.js";
import { runGate } from "./gate.js";
import {
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
const MAX_ATTEMPTS = 2;
const MAX_PREBUILD_REJECTIONS = 3;

export async function appendLog(db: Database, buildId: number, step: string, message: string): Promise<void> {
  const entry = { at: new Date().toISOString(), step, message: message.slice(0, 4000) };
  console.log(`build ${buildId} [${step}] ${message.split("\n")[0]}`);
  await db
    .update(builds)
    .set({ log: sql`${builds.log} || ${JSON.stringify([entry])}::jsonb` })
    .where(eq(builds.id, buildId));
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
  const done = await setStatus(db, b.id, status, { finishedAt: new Date(), error: error ?? b.error, activeToken: null });
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
  if (!idea) return finish(db, b, "skipped", null, "No ideas on the board today.");
  const fund = await fundBalance(db, "build");
  const budgetCents = Math.min(fund, Math.round(config.buildBudgetCapUsd * 100));
  if (budgetCents < config.buildBudgetMinUsd * 100) {
    return finish(db, b, "skipped", null, `The build fund ($${(fund / 100).toFixed(2)}) is below the $${config.buildBudgetMinUsd} minimum for a build. Commit credits to fund tomorrow's build.`);
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
  const [idea] = await db.select({ idea: ideas, login: users.githubLogin, githubId: users.githubId }).from(ideas).innerJoin(users, eq(users.id, ideas.authorId)).where(eq(ideas.id, b.ideaId!));
  if (!idea) return finish(db, b, "failed", null, "The idea disappeared.");
  // A restart mid-attempt: meter what that attempt spent, then start it again cleanly.
  if (b.activeToken) {
    b = await addCost(db, b, await revokeToken(b.activeToken), `Attempt ${b.attempt} (interrupted)`);
    b = await setStatus(db, b.id, "building", { activeToken: null });
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
    if (budgetUsd < 1) return finish(db, b, "failed", "failed", feedback ? "The idea couldn't pass the guardrails within the budget." : "The budget ran out before building.");
    if (attempt === 1) await resetWorkTree(dirs, baseSha!);
    const token = newBuildToken();
    await registerToken(token, budgetUsd, `build ${b.id} attempt ${attempt}`);
    b = await setStatus(db, b.id, "building", { attempt, activeToken: token });
    await appendLog(db, b.id, "build", `Attempt ${attempt}: the builder is working (budget $${budgetUsd.toFixed(2)}, model ${config.buildModel}).`);
    const result = await runAttempt(dirs, { buildId: b.id, attempt, budgetUsd, idea: { id: idea.idea.id, title: idea.idea.title, body: idea.idea.body, author: idea.login }, feedback }, token);
    b = await setStatus(db, b.id, "gating", { activeToken: null, summary: result.summary || b.summary });
    b = await addCost(db, b, result.costUsd, `Builder attempt ${attempt}`);
    await appendLog(db, b.id, "build", `Attempt ${attempt} ${result.status}; $${result.costUsd.toFixed(2)} spent.${result.error ? ` ${result.error}` : ""}`);
    if (result.status === "gave_up") return finish(db, b, "failed", "failed", `The builder couldn't build this within oojam's rules: ${result.summary}`);
    if (result.status === "error" && !result.summary) {
      feedback = `The previous attempt didn't finish: ${result.error ?? "unknown error"}. Log tail:\n${result.logTail}`;
      b = await setStatus(db, b.id, "building", { gateReport: feedback });
      continue;
    }
    const headSha = await commitWorkTree(dirs, `${idea.idea.title}\n\nBuilt by oojam's daily builder for idea #${idea.idea.id}.`);
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
      idea: idea.idea,
      routes: result.routes,
      reviewBudgetUsd: Math.max(1, Math.min(8, remainingUsd(b))),
      log: (step, message) => appendLog(db, b.id, step, message),
    });
    b = await addCost(db, b, gate.reviewCostUsd, "Independent review");
    b = await setStatus(db, b.id, "gating", { gateReport: gate.report });
    if (gate.passed) return openPr(db, b, dirs, headSha, idea.idea, { login: idea.login, githubId: idea.githubId });
    await appendLog(db, b.id, "gate", `Attempt ${attempt} was blocked by the guardrails.`);
    feedback = gate.report;
  }
  return finish(db, b, "failed", "failed", "The change didn't pass oojam's guardrails after two attempts. See the gate report.");
}

interface BuildEntry {
  day: string;
  ideaId: number;
  title: string;
  author: string;
  prUrl: string;
  summary: string;
}

async function openPr(
  db: Database,
  b: Build,
  dirs: ReturnType<typeof buildDirs>,
  builderSha: string,
  idea: typeof ideas.$inferSelect,
  author: { login: string; githubId: number },
): Promise<Build> {
  if (config.dryRun) {
    await appendLog(db, b.id, "pr", "Dry run: the change passed every gate. Not opening a PR.");
    return finish(db, b, "skipped", "open", "Dry run complete.");
  }
  const branch = `build/${b.day}-idea-${idea.id}`;
  // Push the builder's commit first so the PR exists; then add the changelog entry, which needs the PR URL.
  await pushBranch(dirs, builderSha, branch);
  const firstLine = (b.summary ?? "").split("\n").find((l) => l.trim()) ?? idea.title;
  const body = `## ${idea.title}

Idea #${idea.id} by @${author.login}, built by oojam's daily builder on ${b.day}.
${idea.body ? `\n> ${idea.body.slice(0, 2000).replace(/\n/g, "\n> ")}\n` : ""}
### What was built
${b.summary || "(no summary)"}

### Guardrails
${b.gateReport ?? ""}

Cost so far: $${(b.costCents / 100).toFixed(2)} of a $${(b.budgetCents / 100).toFixed(2)} budget · [build page](${config.platformUrl}/builds/${b.id})

This PR is merged automatically when CI passes.`;
  const pr = await openPullRequest({ branch, title: idea.title, body: body.slice(0, 60_000) });
  const entries = JSON.parse(readFileSync(join(dirs.workTree, "content/builds.json"), "utf8")) as BuildEntry[];
  entries.push({ day: b.day, ideaId: idea.id, title: idea.title, author: author.login, prUrl: pr.html_url, summary: firstLine.replace(/^#+\s*/, "").slice(0, 280) });
  const head = await commitPlatformFile(dirs, "content/builds.json", `${JSON.stringify(entries, null, 2)}\n`, `Add ${b.day} to the changelog`);
  await pushBranch(dirs, head, branch);
  await appendLog(db, b.id, "pr", `Opened ${pr.html_url}`);
  return setStatus(db, b.id, "pr_open", { branch, prNumber: pr.number, prUrl: pr.html_url });
}

async function stepMerge(db: Database, b: Build): Promise<Build> {
  const [idea] = await db.select({ idea: ideas, login: users.githubLogin, githubId: users.githubId }).from(ideas).innerJoin(users, eq(users.id, ideas.authorId)).where(eq(ideas.id, b.ideaId!));
  const { gh } = await import("./github.js");
  const pr = await gh<{ head: { sha: string }; merged: boolean; merge_commit_sha: string | null; state: string }>("GET", `/repos/${config.siteRepo}/pulls/${b.prNumber}`);
  if (pr.merged && pr.merge_commit_sha) return setStatus(db, b.id, "deploying", { mergeSha: pr.merge_commit_sha });
  if (pr.state !== "open") return finish(db, b, "failed", "failed", "The PR was closed before it could be merged.");
  await appendLog(db, b.id, "ci", "Waiting for CI");
  const checks = await waitForChecks(pr.head.sha, 45 * 60_000);
  if (checks.failures.length) {
    await commentOnPullRequest(b.prNumber!, `CI failed, so this build won't be merged:\n${checks.failures.map((f) => `- ${f}`).join("\n")}`).catch(() => {});
    await closePullRequest(b.prNumber!).catch(() => {});
    return finish(db, b, "failed", "failed", `CI failed: ${checks.failures.join("; ")}`);
  }
  if ((await getPaused(db)).paused) {
    await appendLog(db, b.id, "paused", "CI passed, but the system is paused; the merge waits.");
    return b;
  }
  await setStatus(db, b.id, "merging");
  const message = `Idea #${idea!.idea.id}, built on ${b.day}. ${config.platformUrl}/builds/${b.id}\n\n${coAuthorTrailer(idea!.githubId, idea!.login)}`;
  const mergeSha = await squashMerge(b.prNumber!, pr.head.sha, `${idea!.idea.title} (#${b.prNumber})`, message);
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

/** The fund only ever goes down by real spend. Exposed for the admin page. */
export async function buildSpend(db: Database, buildId: number): Promise<number> {
  const [row] = await db.select({ c: sql<number>`coalesce(-sum(${fundEntries.deltaCents}), 0)::int` }).from(fundEntries).where(eq(fundEntries.buildId, buildId));
  return row?.c ?? 0;
}
