/**
 * The worker: the daily cycle on a cron (00:00 UTC), plus a 30-second loop that retries
 * unscreened ideas and handles admin requests (run now, roll back). One cycle at a time.
 */
import { Cron } from "croner";
import { inArray, not } from "drizzle-orm";

import { takeWorkerRequest } from "../core/admin.js";
import { config } from "../core/config.js";
import { audit } from "../core/controls.js";
import { screenAndApply, unscreenedIdeaIds } from "../core/ideas.js";
import { utcDay } from "../core/time.js";
import { closeDb, getDb } from "../db/client.js";
import { builds } from "../db/schema.js";
import { runCycle } from "./cycle.js";
import { deploySite, ensureSiteRunning, rollbackTo } from "./deployer.js";
import { freshCheckout } from "./workspace.js";

const db = getDb();
let busy: Promise<unknown> | undefined;

/** Serialises everything that touches builds or deployments. */
function exclusive<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
  if (busy) {
    console.log(`worker: ${name} skipped; something else is running`);
    return Promise.resolve(undefined);
  }
  const p = fn()
    .catch((error: unknown) => {
      console.error(`worker: ${name} failed:`, error);
      return undefined;
    })
    .finally(() => {
      busy = undefined;
    });
  busy = p;
  return p;
}

async function resumeUnfinished(): Promise<void> {
  const open = await db
    .select({ day: builds.day })
    .from(builds)
    .where(not(inArray(builds.status, ["deployed", "failed", "rolled_back", "skipped"])));
  for (const b of open) {
    console.log(`worker: resuming the build for ${b.day}`);
    await runCycle(db, b.day);
  }
}

const RETRY_EVERY_MS = 5 * 60_000;
let lastResume = 0;

async function tick(): Promise<void> {
  for (const id of await unscreenedIdeaIds(db)) await screenAndApply(db, id);
  // A step that threw (an API or GitHub outage) leaves its build unfinished; try again later.
  if (!busy && Date.now() - lastResume > RETRY_EVERY_MS) {
    lastResume = Date.now();
    void exclusive("resume", resumeUnfinished);
  }
  if (busy) return; // leave admin requests queued until we're free
  const req = await takeWorkerRequest(db);
  if (!req) return;
  if (req.type === "run_cycle") {
    await exclusive("run_cycle", () => runCycle(db, utcDay()));
  } else if (req.type === "deploy_main") {
    // A maintainer's change on main (no build involved): same safe path as a merged build.
    await exclusive("deploy_main", async () => {
      const { baseSha } = await freshCheckout(-1);
      await deploySite(db, baseSha, null, async (m) => console.log(`worker: deploy main: ${m}`));
      await audit(db, req.by, "deploy_main_done", "site", { sha: baseSha });
    });
  } else if (req.type === "rollback") {
    await exclusive("rollback", async () => {
      await rollbackTo(db, req.deploymentId);
      await audit(db, req.by, "rollback_done", `deployment:${req.deploymentId}`);
    });
  }
}

async function main(): Promise<void> {
  console.log(`worker: starting (cron "${config.cycleCron}" UTC${config.dryRun ? ", DRY RUN" : ""})`);
  await exclusive("startup", async () => {
    // Serving main is always safe, dry run or not: it pushes and merges nothing.
    await ensureSiteRunning(db, async (m) => console.log(`worker: ${m}`));
    await resumeUnfinished();
  });

  const cron = new Cron(config.cycleCron, { timezone: "UTC", protect: true }, () => {
    void exclusive("cycle", () => runCycle(db, utcDay()));
  });
  console.log(`worker: next cycle at ${cron.nextRun()?.toISOString()}`);

  let stopping = false;
  const loop = async () => {
    while (!stopping) {
      await tick().catch((error: unknown) => console.error("worker: tick failed:", error));
      await new Promise((r) => setTimeout(r, 30_000));
    }
  };
  void loop();

  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.on(sig, () => {
      stopping = true;
      cron.stop();
      console.log("worker: stopping");
      // A build in progress resumes from its recorded state on the next start.
      void closeDb().finally(() => process.exit(0));
    });
  }
}

void main();
