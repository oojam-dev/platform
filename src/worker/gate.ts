/**
 * The full gate for one attempt (SPEC §5): static checks, then build + tests in Docker, then a
 * smoke test against a copy of production data, then the independent review. Stops at the
 * first stage that blocks, so a broken build doesn't pay for a review.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { config } from "../core/config.js";
import { npmRegistry } from "../guardrails/deps.js";
import { readChanges } from "../guardrails/git.js";
import { formatReport, runStaticGates } from "../guardrails/index.js";
import { reviewChange, reviewFindings } from "../guardrails/review.js";
import { blocks, type Finding } from "../guardrails/types.js";
import { HARDENED, docker, removeContainer, removeNetwork, tail, waitFor } from "./docker.js";
import { diffText, exportCommit, type BuildDirs } from "./workspace.js";

export interface GateResult {
  passed: boolean;
  findings: Finding[];
  report: string;
  image?: string;
  reviewCostUsd: number;
}

export const siteImage = (sha: string) => `oojam-site:${sha.slice(0, 12)}`;

/** docker build of a clean export. The site's Dockerfile runs check, test and build. */
export async function buildSiteImage(dir: string, sha: string): Promise<{ ok: boolean; output: string }> {
  const r = await docker(["build", "--pull=false", "--label", "oojam.site=1", "-t", siteImage(sha), dir], { timeoutMs: 20 * 60_000, allowFail: true });
  return { ok: r.code === 0, output: tail(`${r.stdout}\n${r.stderr}`, 6000) };
}

function latestSiteBackup(): string | undefined {
  const dir = join(config.dataDir, "backups");
  try {
    return readdirSync(dir)
      .filter((f) => /^site-.*\.dump$/.test(f))
      .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)[0]?.f.replace(/^/, `${dir}/`);
  } catch {
    return undefined;
  }
}

const GUARDS_SQL = process.env.GUARDS_SQL ?? "/app/deploy/postgres/initdb/02-guards.sql";

/**
 * Restores the latest production backup into a scratch Postgres, applies the new migrations,
 * starts the image and runs the browser smoke test against it. Returns problems found.
 */
export async function smokeTest(buildId: number, sha: string, routes: string[]): Promise<Finding[]> {
  const net = `oojam_smoke_${buildId}`;
  const db = `oojam-smoke-db-${buildId}`;
  const site = `oojam-smoke-site-${buildId}`;
  const runner = `oojam-smoke-run-${buildId}`;
  const findings: Finding[] = [];
  const fail = (message: string) => findings.push({ check: "smoke", severity: "block", message });
  const cleanup = async () => {
    for (const c of [runner, site, db]) await removeContainer(c);
    await removeNetwork(net);
  };
  await cleanup();
  try {
    // An explicit subnet, so a host with many networks doesn't run out of default pools.
    await docker(["network", "create", "--internal", "--subnet", `10.213.${buildId % 250}.0/24`, net]);
    await docker(["run", "-d", "--name", db, "--network", net, "-e", "POSTGRES_PASSWORD=smoke", "-e", "POSTGRES_DB=site", "--tmpfs", "/var/lib/postgresql/data", config.postgresImage]);
    const ready = await waitFor(async () => (await docker(["exec", db, "pg_isready", "-U", "postgres", "-d", "site"], { allowFail: true })).code === 0, 60_000);
    if (!ready) return (fail("The scratch database didn't start."), findings);
    const backup = latestSiteBackup();
    if (backup) {
      await docker(["cp", backup, `${db}:/tmp/site.dump`]);
      const r = await docker(["exec", db, "pg_restore", "--no-owner", "--no-acl", "-U", "postgres", "-d", "site", "/tmp/site.dump"], { allowFail: true });
      if (r.code !== 0) console.warn(`smoke: restore warnings: ${tail(r.stderr, 500)}`);
    }
    // The same data-loss guards as production (idempotent), so a bad migration fails here first.
    const guards = await docker(["exec", "-i", db, "psql", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "site"], { input: readFileSync(GUARDS_SQL, "utf8"), allowFail: true });
    if (guards.code !== 0) return (fail(`Couldn't install the data-loss guards in the scratch database: ${tail(guards.stderr, 800)}`), findings);
    const url = `postgres://postgres:smoke@${db}:5432/site`;
    const migrate = await docker(["run", "--rm", "--network", net, ...HARDENED, "--read-only", "--tmpfs", "/tmp", "-e", `DATABASE_URL=${url}`, siteImage(sha), "npm", "run", "db:migrate"], { timeoutMs: 5 * 60_000, allowFail: true });
    if (migrate.code !== 0) return (fail(`Migrations failed against a copy of production data:\n${tail(migrate.stderr || migrate.stdout, 1500)}`), findings);
    await docker([
      "run", "-d", "--name", site, "--network", net, ...HARDENED, "--read-only", "--tmpfs", "/tmp", "--memory", "512m",
      "-e", `DATABASE_URL=${url}`, "-e", "PORT=3000", "-e", "NODE_ENV=production", "-e", `GIT_SHA=${sha}`,
      siteImage(sha),
    ]);
    const smoke = await docker(
      ["run", "--rm", "--name", runner, "--network", net, ...HARDENED, "--memory", "2g", "--tmpfs", "/tmp", "--entrypoint", "node", config.builderImage, "/opt/oojam-builder/dist/smoke.js", `http://${site}:3000`, ...routes],
      { timeoutMs: 5 * 60_000, allowFail: true },
    );
    const line = smoke.stdout.trim().split("\n").pop() ?? "";
    let parsed: { ok: boolean; problems: { route: string; kind: string; detail: string }[] } | undefined;
    try {
      parsed = JSON.parse(line);
    } catch {
      fail(`The smoke test didn't report a result:\n${tail(smoke.stderr || smoke.stdout, 1000)}`);
    }
    for (const p of parsed?.problems ?? []) fail(`${p.route} — ${p.kind}: ${p.detail}`);
    if (findings.length) {
      const logs = await docker(["logs", "--tail", "60", site], { allowFail: true });
      findings.push({ check: "smoke", severity: "warn", message: `Site log:\n${tail(logs.stdout + logs.stderr, 1500)}` });
    }
    return findings;
  } finally {
    await cleanup();
  }
}

export async function runGate(args: {
  buildId: number;
  dirs: BuildDirs;
  baseSha: string;
  headSha: string;
  idea: { title: string; body: string };
  routes: string[];
  reviewBudgetUsd: number;
  log: (step: string, message: string) => Promise<void>;
}): Promise<GateResult> {
  const ran: string[] = [];
  const findings: Finding[] = [];
  const done = (passed: boolean, image?: string, reviewCostUsd = 0): GateResult => ({
    passed,
    findings,
    report: formatReport(findings, ran),
    image,
    reviewCostUsd,
  });

  await args.log("gate", "Static checks");
  const changes = await readChanges(args.dirs, args.baseSha, args.headSha);
  findings.push(...(await runStaticGates(changes, { registry: npmRegistry, minAgeDays: config.depMinAgeDays })));
  ran.push("paths", "migrations", "dependencies", "secrets", "patterns");
  if (blocks(findings).length) return done(false);

  await args.log("gate", "Building the image (typecheck, tests, build)");
  const exportDir = await exportCommit(args.dirs, args.headSha);
  ran.push("build");
  const built = await buildSiteImage(exportDir, args.headSha);
  if (!built.ok) {
    findings.push({ check: "build", severity: "block", message: `The Docker build failed:\n\`\`\`\n${built.output}\n\`\`\`` });
    return done(false);
  }

  await args.log("gate", "Smoke test against a copy of production data");
  ran.push("smoke");
  findings.push(...(await smokeTest(args.buildId, args.headSha, args.routes)));
  if (blocks(findings).length) return done(false, siteImage(args.headSha));

  await args.log("gate", "Independent review");
  ran.push("review");
  const review = await reviewChange({
    dir: exportDir,
    idea: args.idea,
    diff: await diffText(args.dirs, args.baseSha, args.headSha),
    warnings: findings.filter((f) => f.severity === "warn"),
    model: config.reviewModel,
    budgetUsd: args.reviewBudgetUsd,
    apiKey: config.anthropicApiKey,
  });
  findings.push(...reviewFindings(review));
  if (review.summary) findings.push({ check: "review", severity: "warn", message: `Reviewer's summary: ${review.summary}` });
  const passed = blocks(findings).length === 0;
  // The summary isn't a problem; keep it out of the blocking count but in the report.
  return done(passed, siteImage(args.headSha), review.costUsd);
}
