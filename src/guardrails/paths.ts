/** Protected paths, odd files and size limits (SPEC §5.1). */
import type { ChangeSet, ChangedFile, Finding } from "./types.js";

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
const PROTECTED_DIRS = [".github/", ".oojam/", ".claude/"];
/** Never allowed at any depth. */
const FORBIDDEN_NAMES = new Set([".git", ".gitattributes", ".gitmodules", ".npmrc", ".yarnrc", ".yarnrc.yml", ".pnpmfile.cjs"]);

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_FILES = 200;
const MAX_TOTAL_BYTES = 400 * 1024;
/** Generated files that don't count towards the diff size. */
const SIZE_EXEMPT = new Set(["package-lock.json"]);
const SAFE_PATH = /^[A-Za-z0-9._\-/@+()[\] ]+$/;

function protectedReason(path: string): string | undefined {
  if (PROTECTED_FILES.has(path)) return "is managed by oojam and can't be changed by a build";
  if (PROTECTED_DIRS.some((d) => path.startsWith(d))) return "is in a directory managed by oojam";
  const parts = path.split("/");
  if (parts.some((p) => FORBIDDEN_NAMES.has(p))) return "is a file type builds may not create or change";
  return undefined;
}

/** Migrations and their snapshots are history: once written they never change. */
function isMigrationHistory(path: string): boolean {
  return /^drizzle\/[^/]+\.sql$/.test(path) || /^drizzle\/meta\/[^/]+_snapshot\.json$/.test(path);
}

function touchedPaths(f: ChangedFile): string[] {
  return f.oldPath ? [f.oldPath, f.path] : [f.path];
}

export function checkPaths(changes: ChangeSet): Finding[] {
  const findings: Finding[] = [];
  const add = (file: string, message: string) => findings.push({ check: "paths", severity: "block", file, message });

  if (changes.files.length > MAX_FILES) {
    findings.push({ check: "paths", severity: "block", message: `Changes ${changes.files.length} files; the limit is ${MAX_FILES}.` });
  }
  let total = 0;
  for (const f of changes.files) {
    for (const p of touchedPaths(f)) {
      if (!SAFE_PATH.test(p) || p.includes("..") || p.startsWith("/")) add(p, "has characters builds may not use in file names");
      const reason = protectedReason(p);
      if (reason) add(p, reason);
    }
    // Existing migration files can't be modified, deleted or renamed. New ones are fine.
    if (f.status !== "A" && touchedPaths(f).some(isMigrationHistory)) {
      add(f.oldPath ?? f.path, "is an existing migration; write a new migration instead of changing history");
    }
    if (f.status === "D") continue;
    if (f.mode === "120000") add(f.path, "is a symlink; builds may not create symlinks");
    if (f.mode === "160000") add(f.path, "is a submodule; builds may not add submodules");
    if (f.size > MAX_FILE_BYTES) add(f.path, `is ${(f.size / 1024).toFixed(0)} KB; the limit per file is 1 MB`);
    if (f.binary && !f.path.startsWith("public/")) add(f.path, "is binary; binary files may only go in public/");
    if (!SIZE_EXEMPT.has(f.path)) total += f.binary ? f.size : f.added.reduce((n, l) => n + l.text.length + 1, 0);
  }
  if (total > MAX_TOTAL_BYTES) {
    findings.push({
      check: "paths",
      severity: "block",
      message: `The change adds ${(total / 1024).toFixed(0)} KB; the limit is ${MAX_TOTAL_BYTES / 1024} KB.`,
    });
  }
  return findings;
}
