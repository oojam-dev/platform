/**
 * Per-build directories under /opt/oojam/data/builds/<id>/ (same path on the host and in the
 * worker, so bind mounts line up):
 *   repo.git/     the git directory — never mounted into the builder
 *   workspace/    the work tree the builder edits (no .git inside)
 *   export-<sha>/ clean `git archive` exports, for docker build and review
 *   job-<n>/      job.json / result.json for attempt n
 */
import { chownSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

import { config } from "../core/config.js";
import { git, type Repo } from "../guardrails/git.js";
import { authedRemote, publicRemote } from "./github.js";

export interface BuildDirs extends Repo {
  root: string;
}

export function buildDirs(buildId: number): BuildDirs {
  const root = join(config.dataDir, "builds", String(buildId));
  return { root, gitDir: join(root, "repo.git"), workTree: join(root, "workspace") };
}

function chownTree(dir: string, uid = 1000): void {
  // The builder runs as uid 1000; the worker runs as root.
  if (process.getuid?.() !== 0) return;
  const walk = (p: string) => {
    chownSync(p, uid, uid);
    for (const e of readdirSync(p, { withFileTypes: true })) {
      const child = join(p, e.name);
      if (e.isDirectory()) walk(child);
      else if (!e.isSymbolicLink()) chownSync(child, uid, uid);
    }
  };
  walk(dir);
}

/** Fresh checkout of the site's main branch. Returns the base commit. */
export async function freshCheckout(buildId: number): Promise<{ dirs: BuildDirs; baseSha: string }> {
  return freshCheckoutAt(buildDirs(buildId));
}

export async function freshCheckoutAt(dirs: BuildDirs): Promise<{ dirs: BuildDirs; baseSha: string }> {
  rmSync(dirs.root, { recursive: true, force: true });
  mkdirSync(dirs.workTree, { recursive: true });
  await initRepo(dirs);
  const remote = publicRemote();
  // A local path is only ever configured by the operator (development); allow it explicitly.
  const local = !/^https:\/\//.test(remote);
  await git(dirs, ["fetch", "--quiet", ...(local ? [] : ["--depth=50"]), remote, "+refs/heads/main:refs/remotes/origin/main"], {
    config: local ? ["protocol.file.allow=always"] : [],
  });
  await git(dirs, ["checkout", "--quiet", "-f", "-B", "build", "refs/remotes/origin/main"]);
  const baseSha = (await git(dirs, ["rev-parse", "HEAD"])).trim();
  chownTree(dirs.workTree);
  return { dirs, baseSha };
}

async function initRepo(dirs: BuildDirs): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const p = spawn("git", ["init", "--quiet", "--bare", dirs.gitDir], { stdio: "ignore" });
    p.on("close", (c) => (c === 0 ? resolve() : reject(new Error(`git init failed: ${c}`))));
  });
  // A bare repo with a work tree passed per command: core.bare must be off for checkout.
  await git(dirs, ["config", "core.bare", "false"]);
}

/** Restores the work tree to a commit, discarding anything else the builder left. */
export async function resetWorkTree(dirs: BuildDirs, sha: string): Promise<void> {
  await git(dirs, ["reset", "--quiet", "--hard", sha]);
  await git(dirs, ["clean", "-qfdx"]);
  chownTree(dirs.workTree);
}

/** A clean copy of one commit's files, with nothing the builder left lying around. */
export async function exportCommit(dirs: BuildDirs, sha: string): Promise<string> {
  const out = join(dirs.root, `export-${sha.slice(0, 12)}`);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const tar = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const p = spawn("git", ["-c", "core.hooksPath=/dev/null", `--git-dir=${dirs.gitDir}`, "archive", "--format=tar", sha], { stdio: ["ignore", "pipe", "pipe"] });
    p.stdout.on("data", (b: Buffer) => chunks.push(b));
    p.on("close", (c) => (c === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`git archive failed: ${c}`))));
  });
  await new Promise<void>((resolve, reject) => {
    const p = spawn("tar", ["-x", "--no-same-owner", "--no-same-permissions", "-C", out], { stdio: ["pipe", "ignore", "pipe"] });
    p.on("close", (c) => (c === 0 ? resolve() : reject(new Error(`tar failed: ${c}`))));
    p.stdin.on("error", reject);
    p.stdin.end(tar);
  });
  return out;
}

export async function diffText(dirs: BuildDirs, base: string, head: string, maxBytes = 300_000): Promise<string> {
  const d = await git(dirs, ["diff", "--no-color", "--no-ext-diff", "-M", base, head, "--", ".", ":(exclude)package-lock.json"]);
  return d.length > maxBytes ? `${d.slice(0, maxBytes)}\n… diff truncated (${d.length} bytes) — read the files directly …` : d;
}

/** Commits a file the platform manages (content/builds.json) on top of the builder's work. */
export async function commitPlatformFile(dirs: BuildDirs, relPath: string, content: string, message: string): Promise<string> {
  writeFileSync(join(dirs.workTree, relPath), content);
  await git(dirs, ["add", "--", relPath]);
  await git(dirs, ["commit", "--no-verify", "--quiet", "-F", "-"], { input: message });
  return (await git(dirs, ["rev-parse", "HEAD"])).trim();
}

export async function pushBranch(dirs: BuildDirs, sha: string, branch: string): Promise<void> {
  if (config.dryRun) return;
  await git(dirs, ["push", "--quiet", "--force", await authedRemote(), `${sha}:refs/heads/${branch}`]);
}

export function cleanupBuild(buildId: number): void {
  const { root } = buildDirs(buildId);
  if (existsSync(root)) rmSync(root, { recursive: true, force: true });
}
