/**
 * Tool-use policy for the daily builder (SPEC §4.2), adapted from Contactzilla Extend's.
 *
 * Best effort only. A shell can always get round pattern rules, so none of this is the
 * security boundary. That is: the container (no credentials, internal network, egress only
 * to the gateway and the npm registry), and the host-side guardrails that judge the result
 * (SPEC §5). These rules keep a well-meaning agent out of trouble and make mistakes loud.
 */
import path from "node:path";

export type Decision = { allow: true } | { allow: false; reason: string };

export interface PolicyOptions {
  workspace: string;
  scratchDirs: string[];
  readOnlyDirs: string[];
  realpath?: (p: string) => string;
}

export const DEFAULT_POLICY: PolicyOptions = {
  workspace: "/workspace",
  scratchDirs: ["/tmp"],
  readOnlyDirs: ["/opt/oojam-builder/docs"],
};

const ALLOW: Decision = { allow: true };
const deny = (reason: string): Decision => ({ allow: false, reason });

/** Mirrors the host's protected-path gate (platform src/guardrails/paths.ts). */
const PROTECTED_FILES = new Set([
  "LICENSE",
  "CLAUDE.md",
  "Dockerfile",
  ".dockerignore",
  ".nvmrc",
  "scripts/migrate.mjs",
  "app/routes/_health.ts",
  "content/builds.json",
  ".mcp.json",
]);
const PROTECTED_DIRS = [".github", ".oojam", ".claude"];
const FORBIDDEN_NAMES = new Set([".git", ".gitattributes", ".gitmodules", ".npmrc", ".yarnrc", ".yarnrc.yml"]);

const BASH_RULES: { re: RegExp; reason: string }[] = [
  { re: /(^|[\s;&|(`/])(env|printenv)(?=$|[\s;&|)`])/, reason: "Listing environment variables is not allowed." },
  { re: /(^|[\s;&|(`])(export\s+-p|declare\s+-[a-zA-Z]*[xp]|compgen\s+-e)(?=$|[\s;&|)`])/, reason: "Listing environment variables is not allowed." },
  { re: /\/proc\/[^\s]*environ/, reason: "Reading process environments is not allowed." },
  { re: /ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN/, reason: "The builder may not read its own credentials." },
  { re: /(^|[\s;&|(`])git\b[^;&|\n]*\s(push|remote|config|fetch|pull|clone|submodule|filter-branch|update-ref|reset\s+--hard)\b/, reason: "Git is managed by oojam; just edit files. Your work is committed for you." },
  { re: /(^|[\s;&|(`])(npm|npx|pnpm|yarn)\s+(publish|adduser|login|logout|token|owner|access|unpublish|deprecate|dist-tag|team|org|hook|star)\b/, reason: "Publishing and npm account commands are not allowed." },
  { re: /(^|[\s;&|(`/])(curl|wget|nc|ncat|netcat|socat|ssh|scp|sftp|rsync|telnet|ftp)(?=$|[\s;&|)`])/, reason: "Network tools are not available; the site may not use outside services." },
  { re: /(^|[\s;&|(`/])(docker|podman|sudo|su|chroot|mount|nsenter)(?=$|[\s;&|)`])/, reason: "That command is not available in the builder." },
  { re: /169\.254\.169\.254|metadata\.google\.internal/i, reason: "Instance metadata endpoints are blocked." },
  { re: /\brm\s+(-[a-zA-Z]*\s+)*(\/workspace\/?|\.\/?|\*)(\s|$)/, reason: "Deleting the whole workspace is not allowed." },
  { re: /\brm\s+(-[a-zA-Z]*\s+)*[^\s;&|]*\bdrizzle\b/, reason: "Existing migrations are history and must not be deleted. Write a new migration instead." },
  { re: /--unsafe-perm|--ignore-scripts=false|ignore-scripts\s*=?\s*false/, reason: "Install scripts stay disabled." },
];

function normalise(p: string, opts: PolicyOptions): string {
  const abs = path.posix.isAbsolute(p) ? p : path.posix.join(opts.workspace, p);
  return path.posix.normalize(abs).replace(/\/+$/, "") || "/";
}

function isWithin(p: string, dir: string): boolean {
  const d = dir.replace(/\/+$/, "");
  return p === d || p.startsWith(`${d}/`);
}

function candidates(p: string, opts: PolicyOptions): string[] {
  const lexical = normalise(p, opts);
  const real = opts.realpath ? normalise(opts.realpath(lexical), opts) : lexical;
  return real === lexical ? [lexical] : [lexical, real];
}

export function protectedReason(rel: string): string | undefined {
  if (PROTECTED_FILES.has(rel)) return `${rel} is managed by oojam and must not be changed.`;
  const parts = rel.split("/");
  if (PROTECTED_DIRS.includes(parts[0]!)) return `${parts[0]}/ is managed by oojam and must not be changed.`;
  const bad = parts.find((p) => FORBIDDEN_NAMES.has(p));
  if (bad) return `${bad} files may not be created or changed.`;
  if (/^drizzle\/[^/]+\.sql$/.test(rel) || /^drizzle\/meta\/[^/]+_snapshot\.json$/.test(rel)) {
    return undefined; // new migrations are fine; existing ones are checked by existsAlready
  }
  return undefined;
}

export function checkPath(p: string, mode: "read" | "write", opts: PolicyOptions, existsAlready?: (abs: string) => boolean): Decision {
  if (typeof p !== "string" || !p || p.includes("\0")) return deny("A valid file path is required.");
  for (const c of candidates(p, opts)) {
    if (/^\/proc\/[^/]+\/environ$/.test(c)) return deny("Reading process environments is not allowed.");
    const writable = [opts.workspace, ...opts.scratchDirs];
    const roots = mode === "write" ? writable : [...writable, ...opts.readOnlyDirs, "/usr", "/opt/oojam-builder"];
    if (!roots.some((r) => isWithin(c, r))) {
      return deny(mode === "write" ? `Writes are only allowed under ${writable.join(" and ")}.` : `${c} is off limits.`);
    }
    if (mode === "write" && isWithin(c, opts.workspace)) {
      const rel = path.posix.relative(opts.workspace, c);
      const reason = protectedReason(rel);
      if (reason) return deny(reason);
      const isHistory = /^drizzle\/[^/]+\.sql$/.test(rel) || /^drizzle\/meta\/[^/]+_snapshot\.json$/.test(rel);
      if (isHistory && existsAlready?.(c)) {
        return deny(`${rel} is an existing migration. Migrations are history: add a new one with \`npm run db:generate\`.`);
      }
    }
  }
  return ALLOW;
}

export function checkBash(command: string): Decision {
  for (const rule of BASH_RULES) if (rule.re.test(command)) return deny(rule.reason);
  return ALLOW;
}

const str = (o: Record<string, unknown>, k: string) => (typeof o[k] === "string" ? (o[k] as string) : undefined);

export function evaluateToolUse(tool: string, raw: unknown, opts: PolicyOptions = DEFAULT_POLICY, existsAlready?: (abs: string) => boolean): Decision {
  const input = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  switch (tool) {
    case "Read":
      return checkPath(str(input, "file_path") ?? "", "read", opts);
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return checkPath(str(input, "file_path") ?? str(input, "notebook_path") ?? "", "write", opts, existsAlready);
    case "Glob":
    case "Grep": {
      const p = str(input, "path");
      return p ? checkPath(p, "read", opts) : ALLOW;
    }
    case "Bash":
      return checkBash(str(input, "command") ?? "");
    default:
      return ALLOW;
  }
}

/** Drops the gateway token from every shell the agent runs. */
export function withoutShellSecrets(command: string): string {
  return `unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN\n${command}`;
}
