/** A thin wrapper over the docker CLI (the worker mounts the host's socket). */
import { spawn } from "node:child_process";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export function docker(args: string[], opts: { input?: string; timeoutMs?: number; allowFail?: boolean } = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timedOut = false;
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, opts.timeoutMs)
      : undefined;
    child.stdout.on("data", (b: Buffer) => out.push(b));
    child.stderr.on("data", (b: Buffer) => err.push(b));
    child.on("error", reject);
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      const r = { code: code ?? -1, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), timedOut };
      if (r.code !== 0 && !opts.allowFail) reject(new DockerError(args, r));
      else resolve(r);
    });
    child.stdin.end(opts.input ?? "");
  });
}

export class DockerError extends Error {
  constructor(
    public args: string[],
    public result: RunResult,
  ) {
    super(`docker ${args.slice(0, 2).join(" ")} failed (${result.timedOut ? "timed out" : result.code}): ${tail(result.stderr || result.stdout, 1500)}`);
  }
}

export function tail(s: string, n: number): string {
  return s.length > n ? `…${s.slice(-n)}` : s;
}

export async function removeContainer(name: string): Promise<void> {
  await docker(["rm", "-f", name], { allowFail: true });
}

export async function removeNetwork(name: string): Promise<void> {
  await docker(["network", "rm", name], { allowFail: true });
}

export async function containerExists(name: string): Promise<boolean> {
  return (await docker(["container", "inspect", name], { allowFail: true })).code === 0;
}

export async function imageExists(tag: string): Promise<boolean> {
  return (await docker(["image", "inspect", tag], { allowFail: true })).code === 0;
}

/** Hardening shared by every container the worker starts for untrusted code. */
export const HARDENED = ["--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "512"];

/** Polls a command until it succeeds or time runs out. */
export async function waitFor(check: () => Promise<boolean>, timeoutMs: number, everyMs = 1000): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check().catch(() => false)) return true;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  return false;
}
