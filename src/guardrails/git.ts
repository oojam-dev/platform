/**
 * Git on the host, against a work tree the builder controlled. The builder's container
 * never sees the git directory: it lives beside the work tree and every command names it
 * explicitly, with hooks, fsmonitor and attribute filters off. So nothing the builder wrote
 * can make git run code on the host. File contents come from git blobs, never by following
 * paths on disk (a symlink can't point us at a host file).
 */
import { spawn } from "node:child_process";

import type { ChangeSet, ChangedFile, ChangeStatus } from "./types.js";

const SAFE_CONFIG = [
  "-c", "core.hooksPath=/dev/null",
  "-c", "core.fsmonitor=false",
  "-c", "core.untrackedCache=false",
  "-c", "core.symlinks=true",
  "-c", "core.quotePath=false",
  "-c", "protocol.file.allow=never",
  "-c", "diff.external=",
  "-c", "core.attributesFile=/dev/null",
  "-c", "commit.gpgsign=false",
  "-c", "user.name=oojam-builder",
  "-c", "user.email=builder@oojam.dev",
];

export interface Repo {
  gitDir: string;
  workTree: string;
}

export function git(repo: Repo, args: string[], opts: { input?: string; env?: Record<string, string>; config?: string[] } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const extra = (opts.config ?? []).flatMap((c) => ["-c", c]);
    const child = spawn("git", [...SAFE_CONFIG, ...extra, `--git-dir=${repo.gitDir}`, `--work-tree=${repo.workTree}`, ...args], {
      cwd: repo.workTree,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: "/nonexistent",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
        GIT_ATTR_NOSYSTEM: "1",
        ...opts.env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (b: Buffer) => out.push(b));
    child.stderr.on("data", (b: Buffer) => err.push(b));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(out).toString("utf8"));
      else reject(new Error(`git ${args[0]} failed (${code}): ${Buffer.concat(err).toString("utf8").trim()}`));
    });
    child.stdin.end(opts.input ?? "");
  });
}

/** Stages everything the builder did and commits it. Returns the new HEAD, or undefined if nothing changed. */
export async function commitWorkTree(repo: Repo, message: string): Promise<string | undefined> {
  await git(repo, ["add", "--all", "--force", "--", "."]);
  const staged = await git(repo, ["diff", "--cached", "--name-only"]);
  if (!staged.trim()) return undefined;
  await git(repo, ["commit", "--no-verify", "--quiet", "-F", "-"], { input: message });
  return (await git(repo, ["rev-parse", "HEAD"])).trim();
}

const MAX_TEXT = 1024 * 1024;

/** Reads the change between two commits into a ChangeSet. */
export async function readChanges(repo: Repo, baseSha: string, headSha: string): Promise<ChangeSet> {
  const raw = await git(repo, ["diff", "--raw", "-z", "-M", "--no-abbrev", baseSha, headSha]);
  const parts = raw.split("\0").filter((p, i, a) => !(p === "" && i === a.length - 1));
  const files: ChangedFile[] = [];
  for (let i = 0; i < parts.length; ) {
    const meta = parts[i++]!;
    // :oldmode newmode oldsha newsha STATUS
    const [, newMode, , newSha, statusField] = meta.replace(/^:/, "").split(/\s+/) as string[];
    const status = (statusField ?? "M")[0] as ChangeStatus;
    let oldPath: string | undefined;
    let path: string;
    if (status === "R") {
      oldPath = parts[i++]!;
      path = parts[i++]!;
    } else {
      path = parts[i++]!;
    }
    const deleted = status === "D";
    const size = deleted ? 0 : Number((await git(repo, ["cat-file", "-s", newSha!])).trim());
    const file: ChangedFile = {
      status,
      path,
      oldPath,
      mode: deleted ? "" : (newMode ?? ""),
      size,
      binary: false,
      added: [],
    };
    if (!deleted && size <= MAX_TEXT) {
      const content = await git(repo, ["cat-file", "blob", newSha!]);
      file.binary = content.includes("\0") || /[�]/.test(content.slice(0, 8000));
      if (!file.binary) file.content = content;
    } else if (!deleted) {
      file.binary = true;
    }
    if (status !== "A") {
      try {
        const old = await git(repo, ["show", `${baseSha}:${oldPath ?? path}`]);
        if (!old.includes("\0")) file.oldContent = old;
      } catch {
        /* not present at base */
      }
    }
    files.push(file);
  }
  // Added lines with line numbers, from a zero-context diff.
  const patch = await git(repo, ["diff", "-U0", "-M", "--no-color", "--no-ext-diff", baseSha, headSha]);
  const byPath = new Map(files.map((f) => [f.path, f]));
  let current: ChangedFile | undefined;
  let lineNo = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++ ")) {
      const p = line.slice(4).replace(/\t$/, "");
      current = p === "/dev/null" ? undefined : byPath.get(p.replace(/^b\//, ""));
    } else if (line.startsWith("@@")) {
      const m = /\+(\d+)/.exec(line);
      lineNo = m ? Number(m[1]) : 0;
    } else if (line.startsWith("+") && current) {
      current.added.push({ line: lineNo++, text: line.slice(1) });
    }
  }
  return { baseSha, headSha, files };
}
