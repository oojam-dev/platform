/** Runs one builder attempt in its own container (SPEC §4). */
import { randomBytes } from "node:crypto";
import { chownSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { config } from "../core/config.js";
import { HARDENED, docker, removeContainer, tail } from "./docker.js";
import type { BuildDirs } from "./workspace.js";

export interface AttemptInput {
  buildId: number;
  attempt: number;
  budgetUsd: number;
  idea: { id: number; title: string; body: string; author: string };
  feedback: string | null;
}

export interface AttemptResult {
  status: "done" | "gave_up" | "error";
  summary: string;
  routes: string[];
  /** What the gateway metered, which is what we pay. */
  costUsd: number;
  error: string | null;
  logTail: string;
}

async function gateway(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${config.gatewayUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${config.gatewayAdminToken}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok && res.status !== 404) throw new Error(`gateway ${method} ${path}: ${res.status}`);
  return res.status === 404 ? undefined : res.json();
}

export function newBuildToken(): string {
  return `oojam-build-${randomBytes(32).toString("base64url")}`;
}

export async function registerToken(token: string, budgetUsd: number, label: string): Promise<void> {
  await gateway("POST", "/admin/tokens", { token, budgetUsd, label });
}

/** Revokes a token and returns what it spent (0 if the gateway forgot it). */
export async function revokeToken(token: string): Promise<number> {
  const r = (await gateway("DELETE", `/admin/tokens/${encodeURIComponent(token)}`).catch(() => undefined)) as { spentUsd?: number } | undefined;
  return r?.spentUsd ?? 0;
}

export async function runAttempt(dirs: BuildDirs, input: AttemptInput, token: string): Promise<AttemptResult> {
  const jobDir = join(dirs.root, `job-${input.attempt}`);
  mkdirSync(jobDir, { recursive: true });
  if (process.getuid?.() === 0) chownSync(jobDir, 1000, 1000);
  writeFileSync(
    join(jobDir, "job.json"),
    JSON.stringify({
      buildId: input.buildId,
      attempt: input.attempt,
      model: config.buildModel,
      effort: config.buildEffort,
      budgetUsd: input.budgetUsd,
      idea: input.idea,
      feedback: input.feedback,
    }),
  );
  const name = `oojam-build-${input.buildId}-${input.attempt}`;
  await removeContainer(name);
  const run = await docker(
    [
      "run",
      "--name", name,
      "--network", "oojam_builder_net",
      ...HARDENED,
      "--memory", "4g",
      "--cpus", "2",
      "--pids-limit", "1024",
      "--tmpfs", "/tmp:rw,exec,size=2g",
      "-v", `${dirs.workTree}:/workspace:rw`,
      "-v", `${jobDir}:/job:rw`,
      "-e", `ANTHROPIC_API_KEY=${token}`,
      "-e", "ANTHROPIC_BASE_URL=http://gateway:8787",
      "-e", "HTTPS_PROXY=http://egress:3128",
      "-e", "HTTP_PROXY=http://egress:3128",
      "-e", "https_proxy=http://egress:3128",
      "-e", "http_proxy=http://egress:3128",
      "-e", "npm_config_https_proxy=http://egress:3128",
      "-e", "npm_config_proxy=http://egress:3128",
      config.builderImage,
    ],
    { timeoutMs: config.buildTimeoutMin * 60_000, allowFail: true },
  );
  const logs = `${run.stdout}\n${run.stderr}`;
  await removeContainer(name);
  const resultPath = join(jobDir, "result.json");
  const costUsd = await revokeToken(token);
  if (!existsSync(resultPath)) {
    return {
      status: "error",
      summary: "",
      routes: [],
      costUsd,
      error: run.timedOut ? `The builder ran out of time (${config.buildTimeoutMin} minutes).` : `The builder exited without a result (code ${run.code}).`,
      logTail: tail(logs, 4000),
    };
  }
  const r = JSON.parse(readFileSync(resultPath, "utf8")) as Omit<AttemptResult, "costUsd" | "logTail"> & { costUsd: number };
  return {
    status: r.status,
    summary: String(r.summary ?? "").slice(0, 8000),
    routes: Array.isArray(r.routes) ? r.routes.filter((x) => typeof x === "string" && /^\/[^\s/]?[^\s]*$/.test(x) && !x.startsWith("//")).slice(0, 5) : ["/"],
    // Trust the gateway's meter over anything the container reports.
    costUsd: Math.max(costUsd, 0),
    error: r.error ?? null,
    logTail: tail(logs, 4000),
  };
}
