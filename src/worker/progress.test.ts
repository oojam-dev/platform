import { describe, expect, it, vi } from "vitest";

import { redactSecrets } from "../guardrails/content.js";
import { NOTE_MAX, PROGRESS_INTERVAL_MS, ProgressTracker, lastSentence, throttled } from "./progress.js";

describe("lastSentence", () => {
  it("keeps the last sentence of a line", () => {
    expect(lastSentence("I read the routes. Now I'm adding the leaderboard page to app/routes.")).toBe(
      "Now I'm adding the leaderboard page to app/routes.",
    );
  });

  it("joins a short tail to the sentence before it", () => {
    expect(lastSentence("The tests pass after fixing the import path. Done.")).toBe("The tests pass after fixing the import path. Done.");
  });

  it("strips markdown decoration", () => {
    expect(lastSentence("## **Next:** run `npm test`")).toBe("Next: run npm test");
    expect(lastSentence("- Added a `Leaderboard` component")).toBe("Added a Leaderboard component");
  });

  it("trims long text at a word boundary", () => {
    const s = lastSentence(`${"word ".repeat(100)}end`);
    expect(s.length).toBeLessThanOrEqual(NOTE_MAX);
    expect(s.endsWith("word…")).toBe(true);
  });
});

describe("ProgressTracker", () => {
  it("counts tool calls and keeps the latest assistant text", () => {
    const t = new ProgressTracker();
    t.push("Let me look at the site first.\n[tool] Glob\n[tool] Read\n");
    t.push("Now I'll add the page.\n[tool] Write\n");
    expect(t.toolCalls).toBe(3);
    expect(t.note).toBe("Now I'll add the page.");
  });

  it("handles lines split across chunks", () => {
    const t = new ProgressTracker();
    t.push("Writing the te");
    expect(t.note).toBe("");
    t.push("sts now.\n[to");
    t.push("ol] Bash\n");
    expect(t.note).toBe("Writing the tests now.");
    expect(t.toolCalls).toBe(1);
  });

  it("ignores code fences, symbol-only lines and ANSI colour", () => {
    const t = new ProgressTracker();
    t.push("\u001b[32mAdding a helper.\u001b[0m\n```ts\nexport const x = 1;\n```\n---\n");
    expect(t.note).toBe("Adding a helper.");
  });

  it("doesn't count a mention of [tool] mid-line", () => {
    const t = new ProgressTracker();
    t.push("The log shows [tool] Bash lines.\n");
    expect(t.toolCalls).toBe(0);
  });

  it("never keeps a secret in the note", () => {
    const token = `oojam-build-${"a".repeat(43)}`;
    const t = new ProgressTracker({ secrets: ["super-secret-admin-token"] });
    t.push(`My key is ${token} ok.\n`);
    expect(t.note).not.toContain(token);
    t.push("The admin token is super-secret-admin-token here.\n");
    expect(t.note).not.toContain("super-secret-admin-token");
    t.push(`Found sk-ant-api03-${"x".repeat(30)} in the env.\n`);
    expect(t.note).toBe("Found [redacted] in the env.");
    t.push(`Set GITHUB_TOKEN=${"Z".repeat(30)} for CI.\n`);
    expect(t.note).not.toMatch(/Z{24}/);
  });

  it("snapshots what it has seen", () => {
    const t = new ProgressTracker();
    t.push("Running the build.\n[tool] Bash\n");
    const startedAt = new Date("2026-10-14T00:00:05Z");
    expect(t.snapshot({ attempt: 2, startedAt, budgetUsd: 8, spentUsd: 1.25 }, new Date("2026-10-14T00:07:00Z"))).toEqual({
      attempt: 2,
      startedAt: "2026-10-14T00:00:05.000Z",
      updatedAt: "2026-10-14T00:07:00.000Z",
      note: "Running the build.",
      toolCalls: 1,
      spentUsd: 1.25,
      budgetUsd: 8,
    });
  });
});

describe("throttled", () => {
  it("reports at once, then at most once per interval", async () => {
    const t = new ProgressTracker();
    const report = vi.fn(async () => {});
    const tick = throttled(t, report);
    await tick(0);
    await tick(5_000);
    await tick(PROGRESS_INTERVAL_MS - 1);
    expect(report).toHaveBeenCalledTimes(1);
    await tick(PROGRESS_INTERVAL_MS);
    expect(report).toHaveBeenCalledTimes(2);
    await tick(PROGRESS_INTERVAL_MS + 10_000);
    expect(report).toHaveBeenCalledTimes(2);
    await tick(2 * PROGRESS_INTERVAL_MS + 3);
    expect(report).toHaveBeenCalledTimes(3);
  });

  it("never runs two reports at once", async () => {
    const t = new ProgressTracker({ intervalMs: 10 });
    let release!: () => void;
    const report = vi.fn(() => new Promise<void>((r) => (release = r)));
    const tick = throttled(t, report);
    const first = tick(0);
    await tick(1_000);
    expect(report).toHaveBeenCalledTimes(1);
    release();
    await first;
    const second = tick(2_000);
    expect(report).toHaveBeenCalledTimes(2);
    release();
    await second;
  });

  it("survives a failing report", async () => {
    const t = new ProgressTracker({ intervalMs: 10 });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const report = vi.fn(async () => {
      throw new Error("db down");
    });
    const tick = throttled(t, report);
    await tick(0);
    await tick(20);
    expect(report).toHaveBeenCalledTimes(2);
    errors.mockRestore();
  });
});

describe("redactSecrets", () => {
  it("replaces every match of every secret pattern", () => {
    const s = `a sk-ant-${"k".repeat(25)} b ghp_${"g".repeat(36)} c sk-ant-${"q".repeat(25)}`;
    expect(redactSecrets(s)).toBe("a [redacted] b [redacted] c [redacted]");
  });

  it("leaves ordinary text alone", () => {
    expect(redactSecrets("Adding a token counter to the page.")).toBe("Adding a token counter to the page.");
  });
});
