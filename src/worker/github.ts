/**
 * The oojam GitHub App, installed on the site repo only: push branches, open and merge PRs,
 * read check runs. Installation tokens last an hour; we mint one per operation.
 */
import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";

import { config } from "../core/config.js";

const API = "https://api.github.com";

function appJwt(): string {
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iat: now - 60, exp: now + 540, iss: config.githubAppId })}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(readFileSync(config.githubAppPrivateKeyFile, "utf8"), "base64url");
  return `${unsigned}.${signature}`;
}

let cached: { token: string; expires: number } | undefined;

export async function installationToken(): Promise<string> {
  if (cached && cached.expires - Date.now() > 10 * 60_000) return cached.token;
  const res = await fetch(`${API}/app/installations/${config.githubAppInstallationId}/access_tokens`, {
    method: "POST",
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${appJwt()}`, "User-Agent": "oojam-worker" },
    body: JSON.stringify({ repositories: [config.siteRepo.split("/")[1]], permissions: { contents: "write", pull_requests: "write", checks: "read" } }),
  });
  if (!res.ok) throw new Error(`GitHub installation token: ${res.status} ${await res.text()}`);
  const j = (await res.json()) as { token: string; expires_at: string };
  cached = { token: j.token, expires: new Date(j.expires_at).getTime() };
  return j.token;
}

export async function gh<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${await installationToken()}`,
      "User-Agent": "oojam-worker",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new GithubError(method, path, res.status, await res.text());
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export class GithubError extends Error {
  constructor(
    public method: string,
    public path: string,
    public status: number,
    public body: string,
  ) {
    super(`GitHub ${method} ${path}: ${status} ${body.slice(0, 300)}`);
  }
}

/** An HTTPS remote URL with a short-lived token, used for one fetch or push and never stored. */
export async function authedRemote(): Promise<string> {
  return `https://x-access-token:${await installationToken()}@github.com/${config.siteRepo}.git`;
}

export const publicRemote = () => config.siteRepoUrl;

export interface PullRequest {
  number: number;
  html_url: string;
  head: { sha: string };
  mergeable: boolean | null;
  state: string;
}

export function openPullRequest(args: { branch: string; title: string; body: string }): Promise<PullRequest> {
  return gh<PullRequest>("POST", `/repos/${config.siteRepo}/pulls`, { head: args.branch, base: "main", title: args.title, body: args.body, maintainer_can_modify: false });
}

export async function commentOnPullRequest(number: number, body: string): Promise<void> {
  await gh("POST", `/repos/${config.siteRepo}/issues/${number}/comments`, { body });
}

export async function closePullRequest(number: number): Promise<void> {
  await gh("PATCH", `/repos/${config.siteRepo}/pulls/${number}`, { state: "closed" });
}

interface CheckRuns {
  total_count: number;
  check_runs: { name: string; status: string; conclusion: string | null; html_url: string }[];
}

/** Waits for every check on a commit to finish. Resolves with the failures (empty = all green). */
export async function waitForChecks(sha: string, timeoutMs: number): Promise<{ done: boolean; failures: string[] }> {
  const end = Date.now() + timeoutMs;
  // Give CI a moment to register its runs.
  await new Promise((r) => setTimeout(r, 15_000));
  while (Date.now() < end) {
    const runs = await gh<CheckRuns>("GET", `/repos/${config.siteRepo}/commits/${sha}/check-runs?per_page=100`);
    if (runs.total_count > 0 && runs.check_runs.every((c) => c.status === "completed")) {
      const failures = runs.check_runs
        .filter((c) => !["success", "skipped", "neutral"].includes(c.conclusion ?? ""))
        .map((c) => `${c.name}: ${c.conclusion} (${c.html_url})`);
      return { done: true, failures };
    }
    await new Promise((r) => setTimeout(r, 20_000));
  }
  return { done: false, failures: ["CI did not finish in time"] };
}

export async function squashMerge(number: number, headSha: string, title: string, message: string): Promise<string> {
  const r = await gh<{ sha: string; merged: boolean }>("PUT", `/repos/${config.siteRepo}/pulls/${number}/merge`, {
    merge_method: "squash",
    sha: headSha,
    commit_title: title,
    commit_message: message,
  });
  if (!r.merged) throw new Error(`PR #${number} was not merged`);
  return r.sha;
}

export function coAuthorTrailer(githubId: number, login: string): string {
  return `Co-authored-by: ${login} <${githubId}+${login}@users.noreply.github.com>`;
}
