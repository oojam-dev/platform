/**
 * Dependency gate (SPEC §5.3). New and upgraded packages must be exact, old enough to have
 * been noticed if malicious, free of install scripts, from the public registry, and not a
 * near-miss of a popular package's name.
 */
import { POPULAR_PACKAGES } from "./popular.js";
import type { ChangeSet, Finding } from "./types.js";

const PROTECTED_SCRIPTS = ["start", "build", "check", "test", "db:migrate", "db:generate"];
const LIFECYCLE_SCRIPTS = ["preinstall", "install", "postinstall", "prepare", "prepublish", "prepublishOnly", "prepack", "postpack", "dependencies"];
const DEP_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const;
const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const REGISTRY = "https://registry.npmjs.org/";
const MAX_NEW_DIRECT = 5;

interface PackageJson {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  overrides?: unknown;
  workspaces?: unknown;
  bundleDependencies?: unknown;
  bundledDependencies?: unknown;
}

interface LockEntry {
  version?: string;
  resolved?: string;
  integrity?: string;
  hasInstallScript?: boolean;
  link?: boolean;
}

export interface RegistryInfo {
  publishedAt?: Date;
  deprecated?: string;
  installScripts: string[];
  exists: boolean;
}

export type RegistryLookup = (name: string, version: string) => Promise<RegistryInfo>;

function parse<T>(s: string | undefined): T | undefined {
  if (s === undefined) return undefined;
  return JSON.parse(s) as T;
}

/** Damerau–Levenshtein distance capped at 2 (we only care about 0, 1 or more). */
export function nearMiss(a: string, b: string): boolean {
  if (a === b || Math.abs(a.length - b.length) > 1) return false;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, d[i - 2]![j - 2]! + 1);
      d[i]![j] = v;
    }
  }
  return d[a.length]![b.length] === 1;
}

/** Normalised-name confusion too: "react_dom" vs "react-dom", "lodash.js" vs "lodash". */
function lookalike(name: string): string | undefined {
  if (POPULAR_PACKAGES.has(name)) return undefined;
  const norm = (s: string) => s.replace(/^@[^/]+\//, "").replace(/[-_.]/g, "").replace(/js$/, "");
  for (const p of POPULAR_PACKAGES) {
    if (nearMiss(name, p) || (norm(name) === norm(p) && name !== p)) return p;
  }
  return undefined;
}

function allDeps(pkg: PackageJson | undefined): Map<string, string> {
  const m = new Map<string, string>();
  for (const field of DEP_FIELDS) for (const [k, v] of Object.entries(pkg?.[field] ?? {})) m.set(k, v);
  return m;
}

export async function checkDeps(changes: ChangeSet, lookup: RegistryLookup, opts: { minAgeDays: number; now?: Date }): Promise<Finding[]> {
  const findings: Finding[] = [];
  const block = (message: string, file = "package.json") => findings.push({ check: "dependencies", severity: "block", file, message });
  const pkgFile = changes.files.find((f) => f.path === "package.json");
  const lockFile = changes.files.find((f) => f.path === "package-lock.json");
  if (!pkgFile && !lockFile) return findings;

  for (const f of changes.files) {
    if (f.status !== "D" && /(^|\/)(package\.json|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|npm-shrinkwrap\.json)$/.test(f.path) && f.path !== "package.json" && f.path !== "package-lock.json") {
      block("Nested or alternative package manifests aren't allowed.", f.path);
    }
  }
  if (pkgFile?.status === "D" || lockFile?.status === "D") {
    block("package.json and package-lock.json can't be deleted.");
    return findings;
  }

  let before: PackageJson | undefined;
  let after: PackageJson | undefined;
  try {
    before = parse<PackageJson>(pkgFile?.oldContent);
    after = parse<PackageJson>(pkgFile?.content);
  } catch {
    block("package.json isn't valid JSON.");
    return findings;
  }

  if (pkgFile && after) {
    for (const s of PROTECTED_SCRIPTS) {
      if ((before?.scripts?.[s] ?? null) !== (after.scripts?.[s] ?? null)) block(`The "${s}" script is managed by oojam and can't change.`);
    }
    for (const s of LIFECYCLE_SCRIPTS) if (after.scripts?.[s]) block(`Lifecycle script "${s}" isn't allowed.`);
    for (const k of ["overrides", "workspaces", "bundleDependencies", "bundledDependencies"] as const) {
      if (JSON.stringify(before?.[k]) !== JSON.stringify(after[k])) block(`"${k}" in package.json is managed by oojam.`);
    }
  }

  const oldDeps = allDeps(before);
  const newDeps = after ? allDeps(after) : oldDeps;
  const changed = [...newDeps].filter(([name, v]) => oldDeps.get(name) !== v);
  const added = changed.filter(([name]) => !oldDeps.has(name));
  if (added.length > MAX_NEW_DIRECT) block(`Adds ${added.length} new dependencies; the limit is ${MAX_NEW_DIRECT} per build.`);

  for (const [name, spec] of changed) {
    if (!EXACT.test(spec)) {
      block(`${name}@${spec}: pin an exact version (no ranges, tags, git or file specifiers).`);
      continue;
    }
    const looksLike = lookalike(name);
    if (looksLike) block(`${name} looks like a misspelling of the popular package "${looksLike}".`);
    let info: RegistryInfo;
    try {
      info = await lookup(name, spec);
    } catch (error) {
      block(`${name}@${spec}: couldn't check the registry (${error instanceof Error ? error.message : error}).`);
      continue;
    }
    if (!info.exists) {
      block(`${name}@${spec} doesn't exist on the npm registry.`);
      continue;
    }
    const now = opts.now ?? new Date();
    if (!info.publishedAt || (now.getTime() - info.publishedAt.getTime()) / 86_400_000 < opts.minAgeDays) {
      block(`${name}@${spec} was published less than ${opts.minAgeDays} days ago; use an older version.`);
    }
    if (info.deprecated) block(`${name}@${spec} is deprecated: ${info.deprecated.slice(0, 120)}`);
    if (info.installScripts.length) block(`${name}@${spec} runs install scripts (${info.installScripts.join(", ")}).`);
  }

  // The lockfile: anything new or changed must come from the public registry with no install scripts.
  if (lockFile) {
    let oldLock: Record<string, LockEntry> = {};
    let newLock: Record<string, LockEntry> = {};
    try {
      oldLock = parse<{ packages?: Record<string, LockEntry> }>(lockFile.oldContent)?.packages ?? {};
      newLock = parse<{ packages?: Record<string, LockEntry> }>(lockFile.content)?.packages ?? {};
    } catch {
      block("package-lock.json isn't valid JSON.", "package-lock.json");
      return findings;
    }
    for (const [key, entry] of Object.entries(newLock)) {
      if (key === "") continue;
      const prev = oldLock[key];
      if (prev && prev.version === entry.version && prev.resolved === entry.resolved && prev.integrity === entry.integrity && prev.hasInstallScript === entry.hasInstallScript) continue;
      const name = key.replace(/^.*node_modules\//, "");
      if (entry.link) block(`${name} is a linked package.`, "package-lock.json");
      else if (!entry.resolved?.startsWith(REGISTRY)) block(`${name} resolves from ${entry.resolved ?? "nowhere"}, not the npm registry.`, "package-lock.json");
      if (!entry.integrity) block(`${name} has no integrity hash.`, "package-lock.json");
      if (entry.hasInstallScript) block(`${name}@${entry.version} has install scripts.`, "package-lock.json");
    }
    if (pkgFile && !lockFile.content) block("package.json changed but package-lock.json wasn't updated.", "package-lock.json");
  } else if (changed.length) {
    block("Dependencies changed but package-lock.json wasn't updated. Run npm install.", "package-lock.json");
  }
  return findings;
}

/** Real registry lookups (the worker has outbound access; the builder doesn't). */
export const npmRegistry: RegistryLookup = async (name, version) => {
  const res = await fetch(`${REGISTRY}${name.replace("/", "%2F")}`, { headers: { Accept: "application/json" } });
  if (res.status === 404) return { exists: false, installScripts: [] };
  if (!res.ok) throw new Error(`registry ${res.status}`);
  const doc = (await res.json()) as {
    time?: Record<string, string>;
    versions?: Record<string, { deprecated?: string; scripts?: Record<string, string>; hasInstallScript?: boolean }>;
  };
  const v = doc.versions?.[version];
  if (!v) return { exists: false, installScripts: [] };
  const installScripts = ["preinstall", "install", "postinstall"].filter((s) => v.scripts?.[s]);
  if (v.hasInstallScript && installScripts.length === 0) installScripts.push("install (native build)");
  const t = doc.time?.[version];
  return { exists: true, deprecated: v.deprecated, installScripts, publishedAt: t ? new Date(t) : undefined };
};
