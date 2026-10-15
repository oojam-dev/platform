/** Runs the static gates and formats the report (SPEC §5). Build/smoke run in the worker. */
import { checkPaths } from "./paths.js";
import { checkMigrations } from "./migrations.js";
import { checkContent } from "./content.js";
import { checkDeps, type RegistryLookup } from "./deps.js";
import type { ChangeSet, Finding } from "./types.js";

export * from "./types.js";

export async function runStaticGates(
  changes: ChangeSet,
  opts: { registry: RegistryLookup; minAgeDays: number; now?: Date },
): Promise<Finding[]> {
  if (changes.files.length === 0) {
    return [{ check: "paths", severity: "block", message: "The build didn't change anything." }];
  }
  return [
    ...checkPaths(changes),
    ...checkMigrations(changes),
    ...checkContent(changes),
    ...(await checkDeps(changes, opts.registry, { minAgeDays: opts.minAgeDays, now: opts.now })),
  ];
}

const CHECK_TITLES: Record<string, string> = {
  paths: "Protected paths and file limits",
  migrations: "Database migrations (additive only)",
  dependencies: "Dependencies",
  secrets: "Secrets",
  patterns: "Code patterns",
  build: "Build, typecheck and tests",
  smoke: "Smoke test",
  review: "Independent Claude review",
};

/** Markdown for the PR body and the build page. */
export function formatReport(findings: Finding[], ran: string[]): string {
  const lines: string[] = [];
  for (const check of ran) {
    const mine = findings.filter((f) => f.check === check);
    const blocked = mine.some((f) => f.severity === "block");
    const icon = blocked ? "❌" : mine.length ? "⚠️" : "✅";
    lines.push(`- ${icon} **${CHECK_TITLES[check] ?? check}**${mine.length ? "" : ": passed"}`);
    for (const f of mine.slice(0, 25)) {
      const where = f.file ? ` \`${f.file}${f.line ? `:${f.line}` : ""}\`` : "";
      lines.push(`  - ${f.severity === "block" ? "**block**" : "warn"}${where}: ${f.message.replace(/\n/g, " ")}`);
    }
    if (mine.length > 25) lines.push(`  - …and ${mine.length - 25} more`);
  }
  return lines.join("\n");
}
