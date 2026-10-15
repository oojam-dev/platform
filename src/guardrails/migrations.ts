/**
 * Migration lint (SPEC §5.2). Additive only: new tables, columns, indexes, enum values,
 * views and data inserts. Anything that could lose or rewrite data is blocked. The database
 * enforces the worst of this too (event triggers, SPEC §3.3); this catches it before a PR.
 */
import type { ChangeSet, Finding } from "./types.js";

/**
 * Removes comments and the contents of string literals, quoted identifiers and dollar
 * quotes, so keywords inside them can't hide or fake a statement. Exported for tests.
 */
export function stripSql(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const c = sql[i]!;
    const next = sql[i + 1];
    if (c === "-" && next === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      out += " ";
    } else if (c === "/" && next === "*") {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") (depth++, (i += 2));
        else if (sql[i] === "*" && sql[i + 1] === "/") (depth--, (i += 2));
        else i++;
      }
      out += " ";
    } else if (c === "'") {
      // E'...' strings treat backslash as an escape; plain ones don't.
      const escapes = /[eE]/.test(sql[i - 1] ?? "") && !/[A-Za-z0-9_]/.test(sql[i - 2] ?? "");
      i++;
      while (i < sql.length) {
        if (escapes && sql[i] === "\\") i += 2;
        else if (sql[i] === "'" && sql[i + 1] === "'") i += 2;
        else if (sql[i] === "'") break;
        else i++;
      }
      i++;
      out += "''";
    } else if (c === '"') {
      i++;
      while (i < sql.length) {
        if (sql[i] === '"' && sql[i + 1] === '"') i += 2;
        else if (sql[i] === '"') break;
        else i++;
      }
      i++;
      out += '"x"';
    } else if (c === "$") {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        i = end === -1 ? sql.length : end + tag.length;
        out += "$$$$";
      } else {
        out += c;
        i++;
      }
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** Splits at top-level commas (not inside parentheses). */
function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

const NAME = String.raw`(?:"X"|[A-Z_][A-Z0-9_$]*)(?:\s*\.\s*(?:"X"|[A-Z_][A-Z0-9_$]*))?`;
const IFNE = String.raw`(?:IF NOT EXISTS )?`;

const ALLOWED_STATEMENTS: RegExp[] = [
  new RegExp(`^CREATE (?:UNLOGGED )?TABLE ${IFNE}${NAME}`),
  new RegExp(`^CREATE (?:UNIQUE )?INDEX (?:CONCURRENTLY )?${IFNE}(?:${NAME} )?ON `),
  new RegExp(`^CREATE SEQUENCE ${IFNE}${NAME}`),
  new RegExp(`^CREATE TYPE ${NAME} AS ENUM ?\\(`),
  new RegExp(`^CREATE SCHEMA ${IFNE}${NAME}$`),
  new RegExp(`^CREATE VIEW ${NAME}`),
  new RegExp(`^ALTER TYPE ${NAME} ADD VALUE `),
  /^INSERT INTO /,
];

const ALLOWED_ALTER_ACTIONS: RegExp[] = [
  new RegExp(`^ADD (?:COLUMN )?${IFNE}${NAME} `),
  new RegExp(`^ADD CONSTRAINT ${NAME} `),
  new RegExp(`^ALTER (?:COLUMN )?${NAME} SET DEFAULT `),
  new RegExp(`^ALTER (?:COLUMN )?${NAME} DROP DEFAULT$`),
  new RegExp(`^ALTER (?:COLUMN )?${NAME} DROP NOT NULL$`),
];

/** Dangerous anywhere, even inside an otherwise allowed statement. */
const NEVER = /\b(PG_READ_FILE|PG_READ_BINARY_FILE|PG_LS_DIR|PG_STAT_FILE|PG_SLEEP|LO_IMPORT|LO_EXPORT|DBLINK\w*|PG_TERMINATE_BACKEND|PG_CANCEL_BACKEND|SET_CONFIG|PG_AUTHID|PG_SHADOW|COPY|EXECUTE|CREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE|TRIGGER|RULE))\b/;

const HINTS: [RegExp, string][] = [
  [/(?:^|\s)DROP\b/, "Dropping things deletes data or features. Leave the old table or column in place and stop using it."],
  [/(?:^|\s)TRUNCATE\b/, "TRUNCATE deletes every row."],
  [/(?:^|\s)DELETE\b/, "Migrations may not delete rows."],
  [/^UPDATE\b/, "Data updates in migrations must have a WHERE clause."],
  [/ RENAME /, "Renaming breaks the running site during deploy. Add a new column and copy data instead."],
  [/ TYPE |SET DATA TYPE/, "Changing a column's type can rewrite or lose data. Add a new column instead."],
  [/SET NOT NULL/, "SET NOT NULL fails on existing rows. Add a new column with a default instead."],
];

export function lintStatement(stmt: string): string | undefined {
  const s = stmt.replace(/\s+/g, " ").trim().toUpperCase();
  if (!s) return undefined;
  if (NEVER.test(s)) return "uses a function or statement migrations may not use";
  if (s.startsWith("ALTER TABLE ")) {
    const m = new RegExp(`^ALTER TABLE (?:ONLY )?(?:IF EXISTS )?${NAME} (.*)$`).exec(s);
    if (!m) return "is an ALTER TABLE we couldn't read";
    for (const action of splitTopLevel(m[1]!)) {
      if (!ALLOWED_ALTER_ACTIONS.some((re) => re.test(action))) {
        const hint = HINTS.find(([re]) => re.test(` ${action} `))?.[1];
        return `does "${action.slice(0, 60)}", which isn't additive${hint ? `. ${hint}` : ""}`;
      }
    }
    return undefined;
  }
  if (/^UPDATE /.test(s)) return /\bWHERE\b/.test(s) ? undefined : HINTS[3]![1];
  if (ALLOWED_STATEMENTS.some((re) => re.test(s))) return undefined;
  const hint = HINTS.find(([re]) => re.test(s))?.[1];
  return `isn't an allowed migration statement${hint ? `. ${hint}` : ""}`;
}

export function lintSql(sql: string): { statement: string; problem: string }[] {
  const problems: { statement: string; problem: string }[] = [];
  for (const stmt of stripSql(sql).split(";")) {
    const problem = lintStatement(stmt);
    if (problem) problems.push({ statement: stmt.replace(/\s+/g, " ").trim().slice(0, 120), problem });
  }
  return problems;
}

interface Journal {
  entries?: { idx: number; tag: string }[];
}

export function checkMigrations(changes: ChangeSet): Finding[] {
  const findings: Finding[] = [];
  const newSql = changes.files.filter((f) => f.status === "A" && /^drizzle\/[^/]+\.sql$/.test(f.path));
  for (const f of newSql) {
    for (const p of lintSql(f.content ?? "")) {
      findings.push({ check: "migrations", severity: "block", file: f.path, message: `\`${p.statement}\` ${p.problem}` });
    }
  }
  // Other SQL files anywhere are suspicious: only drizzle/ is ever run, so say so.
  for (const f of changes.files) {
    if (f.status !== "D" && f.path.endsWith(".sql") && !f.path.startsWith("drizzle/")) {
      findings.push({ check: "migrations", severity: "warn", file: f.path, message: "SQL outside drizzle/ is never run as a migration." });
    }
  }
  const journal = changes.files.find((f) => f.path === "drizzle/meta/_journal.json");
  if (journal) {
    try {
      const before = JSON.parse(journal.oldContent ?? '{"entries":[]}') as Journal;
      const after = JSON.parse(journal.content ?? "{}") as Journal;
      const old = before.entries ?? [];
      const now = after.entries ?? [];
      const prefixIntact = old.every((e, i) => JSON.stringify(e) === JSON.stringify(now[i]));
      if (!prefixIntact || now.length < old.length) {
        findings.push({
          check: "migrations",
          severity: "block",
          file: journal.path,
          message: "The migration journal may only gain entries at the end; existing entries were changed or removed.",
        });
      }
      const added = new Set(now.slice(old.length).map((e) => `drizzle/${e.tag}.sql`));
      for (const f of newSql) {
        if (!added.has(f.path)) {
          findings.push({ check: "migrations", severity: "block", file: f.path, message: "This migration isn't in the journal, so it would never run. Use `npm run db:generate`." });
        }
      }
    } catch {
      findings.push({ check: "migrations", severity: "block", file: journal.path, message: "The migration journal isn't valid JSON." });
    }
  } else if (newSql.length) {
    findings.push({ check: "migrations", severity: "block", message: "New migrations were added but the journal wasn't updated. Use `npm run db:generate`." });
  }
  return findings;
}
