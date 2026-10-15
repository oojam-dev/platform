/**
 * Deploys the site (SPEC §7): build → back up → migrate → candidate → smoke → promote → verify.
 * Migrations are additive, so the previous container keeps working on the new schema and a
 * rollback is just pointing the "site" alias back at it.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { and, desc, eq, inArray } from "drizzle-orm";

import { config } from "../core/config.js";
import type { Database } from "../db/client.js";
import { deployments } from "../db/schema.js";
import { HARDENED, containerExists, docker, imageExists, removeContainer, tail, waitFor } from "./docker.js";
import { buildSiteImage, siteImage, smokeTest } from "./gate.js";
import { exportCommit, freshCheckout } from "./workspace.js";

const SITE_NET = "oojam_site_net";
const SITE_DB_NET = "oojam_site_db_net";
export const siteContainer = (sha: string) => `oojam-site-${sha.slice(0, 12)}`;

export class DeployError extends Error {}

async function healthy(container: string): Promise<boolean> {
  // Ask from inside the container's own network namespace: the worker isn't on site_net.
  const r = await docker(["exec", container, "node", "-e", "fetch('http://127.0.0.1:3000/_health').then(r=>r.json()).then(j=>process.exit(j.ok?0:1)).catch(()=>process.exit(1))"], { allowFail: true, timeoutMs: 10_000 });
  return r.code === 0;
}

async function publicSha(): Promise<string | undefined> {
  try {
    const res = await fetch(`${config.siteUrl}/_health`, { signal: AbortSignal.timeout(10_000), headers: { "cache-control": "no-cache" } });
    return ((await res.json()) as { sha?: string }).sha;
  } catch {
    return undefined;
  }
}

/** pg_dump inside the backup service's container, as its read-only `backup` role. */
async function backupSite(tag: string): Promise<void> {
  const dir = join(config.dataDir, "backups");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `site-predeploy-${tag}.dump`);
  const ps = await docker(["ps", "-q", "--filter", "label=com.docker.compose.project=oojam", "--filter", "label=com.docker.compose.service=backup"], { allowFail: true });
  const container = ps.stdout.trim().split("\n")[0];
  if (!container) throw new DeployError("The backup service isn't running, so nothing was changed. Start it and retry.");
  const r = await docker(["exec", container, "pg_dump", "-Fc", "-d", "site", "-f", file], { timeoutMs: 15 * 60_000, allowFail: true });
  if (r.code !== 0) throw new DeployError(`Pre-deploy backup failed, so nothing was changed: ${tail(r.stderr, 800)}`);
  console.log(`deploy: backed up to ${file}`);
}

async function startCandidate(sha: string): Promise<string> {
  const name = siteContainer(sha);
  await removeContainer(name);
  await docker([
    "run", "-d", "--name", name,
    "--network", SITE_NET, "--network-alias", "site-candidate",
    ...HARDENED, "--read-only", "--tmpfs", "/tmp", "--memory", "512m", "--pids-limit", "256",
    "--restart", "unless-stopped",
    "--label", "oojam.site=1", "--label", `oojam.sha=${sha}`,
    "-e", `DATABASE_URL=${config.siteDbAppUrl}`, "-e", "PORT=3000", "-e", "NODE_ENV=production", "-e", `GIT_SHA=${sha}`,
    siteImage(sha),
  ]);
  await docker(["network", "connect", SITE_DB_NET, name]);
  return name;
}

async function setLive(name: string, previous: string | undefined): Promise<void> {
  await docker(["network", "disconnect", "-f", SITE_NET, name], { allowFail: true });
  await docker(["network", "connect", "--alias", "site", SITE_NET, name]);
  if (previous && previous !== name) {
    await docker(["network", "disconnect", "-f", SITE_NET, previous], { allowFail: true });
    await docker(["stop", "-t", "10", previous], { allowFail: true });
  }
}

async function liveDeployment(db: Database) {
  const [row] = await db.select().from(deployments).where(eq(deployments.status, "live")).orderBy(desc(deployments.promotedAt)).limit(1);
  return row;
}

/** Deploys a commit of main. Throws DeployError after restoring the previous version. */
export async function deploySite(db: Database, sha: string, buildId: number | null, log: (m: string) => Promise<void>): Promise<void> {
  const tag = sha.slice(0, 12);
  if (!(await imageExists(siteImage(sha)))) {
    await log("Building the image from main");
    const { dirs } = await freshCheckout(buildId ?? 0);
    const dir = await exportCommit(dirs, sha);
    const built = await buildSiteImage(dir, sha);
    if (!built.ok) throw new DeployError(`Image build failed:\n${built.output}`);
  }
  const previous = await liveDeployment(db);
  if (previous) {
    await log("Backing up the site database");
    await backupSite(tag);
  }
  await log("Applying migrations");
  const migrate = await docker(
    ["run", "--rm", "--network", SITE_DB_NET, ...HARDENED, "--read-only", "--tmpfs", "/tmp", "-e", `DATABASE_URL=${config.siteDbMigratorUrl}`, siteImage(sha), "npm", "run", "db:migrate"],
    { timeoutMs: 10 * 60_000, allowFail: true },
  );
  if (migrate.code !== 0) throw new DeployError(`Migrations failed; the previous version is still live:\n${tail(migrate.stderr || migrate.stdout, 1500)}`);

  await log("Starting the new version");
  const name = await startCandidate(sha);
  const [dep] = await db.insert(deployments).values({ buildId, sha, container: name, status: "candidate" }).returning();
  const fail = async (message: string) => {
    await removeContainer(name);
    await db.update(deployments).set({ status: "failed" }).where(eq(deployments.id, dep!.id));
    throw new DeployError(message);
  };
  if (!(await waitFor(() => healthy(name), 90_000, 2000))) {
    const logs = await docker(["logs", "--tail", "50", name], { allowFail: true });
    return fail(`The new version never became healthy:\n${tail(logs.stdout + logs.stderr, 1500)}`);
  }

  await log("Promoting");
  await setLive(name, previous?.container);
  await db.update(deployments).set({ status: "live", promotedAt: new Date() }).where(eq(deployments.id, dep!.id));
  if (previous) await db.update(deployments).set({ status: "retired" }).where(eq(deployments.id, previous.id));

  await log("Checking the public site");
  const ok = await waitFor(async () => (await publicSha()) === sha, 60_000, 3000);
  if (!ok) {
    if (previous && (await containerExists(previous.container))) {
      await docker(["start", previous.container], { allowFail: true });
      await setLive(previous.container, name);
      await db.update(deployments).set({ status: "live" }).where(eq(deployments.id, previous.id));
    }
    await removeContainer(name);
    await db.update(deployments).set({ status: "failed" }).where(eq(deployments.id, dep!.id));
    throw new DeployError(`${config.siteUrl}/_health didn't report the new version, so the previous one was restored.`);
  }
  await pruneRetired(db);
}

/** Keeps the two most recent retired containers for rollback; removes the rest. */
async function pruneRetired(db: Database): Promise<void> {
  const retired = await db.select().from(deployments).where(eq(deployments.status, "retired")).orderBy(desc(deployments.promotedAt));
  for (const d of retired.slice(2)) {
    await removeContainer(d.container);
    await db.update(deployments).set({ status: "failed" }).where(and(eq(deployments.id, d.id), eq(deployments.status, "retired")));
  }
  // Site images from gates and old deploys; anything a container still uses is kept.
  await docker(["image", "prune", "-a", "-f", "--filter", "label=oojam.site=1", "--filter", "until=72h"], { allowFail: true });
}

/** Admin rollback to a retired deployment whose container still exists. */
export async function rollbackTo(db: Database, deploymentId: number): Promise<void> {
  const [target] = await db.select().from(deployments).where(eq(deployments.id, deploymentId));
  if (!target || !(await containerExists(target.container))) throw new DeployError("That deployment's container is gone; deploy its commit instead.");
  const current = await liveDeployment(db);
  await docker(["start", target.container], { allowFail: true });
  if (!(await waitFor(() => healthy(target.container), 60_000, 2000))) throw new DeployError("The old version didn't become healthy.");
  await setLive(target.container, current?.container);
  await db.update(deployments).set({ status: "live", promotedAt: new Date() }).where(eq(deployments.id, target.id));
  if (current) await db.update(deployments).set({ status: "retired" }).where(eq(deployments.id, current.id));
}

/** On first boot (or after a host rebuild) make sure something is serving oojam.dev. */
export async function ensureSiteRunning(db: Database, log: (m: string) => Promise<void>): Promise<void> {
  const live = await liveDeployment(db);
  if (live && (await containerExists(live.container))) {
    await docker(["start", live.container], { allowFail: true });
    return;
  }
  const { dirs, baseSha } = await freshCheckout(0);
  void dirs;
  await log(`No live site; deploying main at ${baseSha.slice(0, 12)}`);
  if (live) await db.update(deployments).set({ status: "failed" }).where(inArray(deployments.id, [live.id]));
  await deploySite(db, baseSha, null, log);
}

export { smokeTest };
