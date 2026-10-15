import { describe, expect, it } from "vitest";

import { checkBash, evaluateToolUse } from "./policy.js";
import { buildPrompt, parseFinal } from "./run.js";

const opts = { workspace: "/workspace", scratchDirs: ["/tmp"], readOnlyDirs: [] };

describe("builder policy", () => {
  it.each([
    ["Write", "/workspace/CLAUDE.md"],
    ["Edit", "/workspace/.github/workflows/ci.yml"],
    ["Write", "/workspace/app/../LICENSE"],
    ["Write", "/workspace/content/builds.json"],
    ["Write", "/workspace/app/.npmrc"],
    ["Write", "/etc/passwd"],
    ["Write", "/workspace/.git/config"],
    ["Read", "/proc/1/environ"],
    ["Read", "/home/builder/.claude.json"],
  ])("denies %s %s", (tool, file_path) => {
    expect(evaluateToolUse(tool, { file_path }, opts).allow).toBe(false);
  });

  it("allows normal work and new migrations, but not edits to old ones", () => {
    expect(evaluateToolUse("Write", { file_path: "app/routes/guestbook.tsx" }, opts).allow).toBe(true);
    expect(evaluateToolUse("Write", { file_path: "/workspace/drizzle/0001_x.sql" }, opts, () => false).allow).toBe(true);
    expect(evaluateToolUse("Edit", { file_path: "/workspace/drizzle/0000_init.sql" }, opts, () => true).allow).toBe(false);
    expect(evaluateToolUse("Read", { file_path: "/workspace/CLAUDE.md" }, opts).allow).toBe(true);
  });

  it.each([
    "env",
    "printenv | grep KEY",
    "cat /proc/self/environ",
    "echo $ANTHROPIC_API_KEY",
    "git push origin main",
    "git config core.hooksPath x",
    "npm publish",
    "curl https://example.com",
    "docker ps",
    "rm -rf /workspace",
    "rm drizzle/0000_init.sql",
    "npm install --ignore-scripts=false foo",
  ])("denies `%s`", (cmd) => {
    expect(checkBash(cmd).allow).toBe(false);
  });

  it.each(["npm run check && npm test && npm run build", "npm install canvas-confetti@1.9.3 --save-exact", "git status", "git diff", "rm app/old.tsx", "npm run db:generate"])(
    "allows `%s`",
    (cmd) => {
      expect(checkBash(cmd).allow).toBe(true);
    },
  );
});

describe("final message", () => {
  it("parses routes and summary", () => {
    expect(parseFinal("Built a guestbook.\n\nROUTES: /guestbook, `/`, //evil.com, javascript:x")).toEqual({
      status: "done",
      summary: "Built a guestbook.",
      routes: ["/guestbook", "/"],
    });
  });
  it("parses giving up", () => {
    expect(parseFinal("Looked at it.\nGAVE_UP: needs outbound network").status).toBe("gave_up");
  });
  it("writes a housekeeping prompt when there's no idea", () => {
    const job = { buildId: 1, attempt: 1, model: "m", effort: "high" as const, budgetUsd: 1, idea: { id: 0, title: "Housekeeping", body: "", author: "oojam-dev" }, feedback: null };
    expect(buildPrompt(job)).toContain("housekeeping day");
    expect(buildPrompt(job)).not.toContain("<idea>");
  });

  it("puts feedback in the prompt on retry", () => {
    const job = { buildId: 1, attempt: 2, model: "m", effort: "high" as const, budgetUsd: 1, idea: { id: 1, title: "T", body: "", author: "a" }, feedback: "- block: x" };
    expect(buildPrompt(job)).toContain("<gate-report>");
  });
});
