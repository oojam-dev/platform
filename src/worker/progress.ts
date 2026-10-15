/**
 * Live progress of a builder attempt (SPEC §4.5). The worker feeds it the container's stdout,
 * which builder/src/run.ts writes as the assistant's text plus one `[tool] Name` line per tool
 * call, and stores a snapshot on the build at most every PROGRESS_INTERVAL_MS. The note is
 * public, so it's trimmed and anything secret-looking is redacted.
 */
import { redactSecrets } from "../guardrails/content.js";
import type { BuildProgress } from "../db/schema.js";

export const PROGRESS_INTERVAL_MS = 30_000;
export const NOTE_MAX = 200;

const TOOL_LINE = /^\[tool\] \S/;
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;
const BUILD_TOKEN = /oojam-build-[A-Za-z0-9_-]{16,}/g;

/** The last sentence of a line of assistant text, without markdown decoration, at most `max` chars. */
export function lastSentence(line: string, max = NOTE_MAX): string {
  const text = line
    .replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|>\s*|\d+[.)]\s+)/, "")
    .replace(/\*\*|__|`/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const sentences = text.split(/(?<=[.!?…])\s+(?=\S)/).filter((s) => /\p{L}/u.test(s));
  let s = sentences.at(-1) ?? text;
  // A short tail like "Done." reads better with the sentence before it.
  if (s.length < 40 && sentences.length > 1) s = `${sentences.at(-2)} ${s}`;
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, "")}…`;
}

export class ProgressTracker {
  private buffer = "";
  private inFence = false;
  private lastEmit = Number.NEGATIVE_INFINITY;
  note = "";
  toolCalls = 0;

  constructor(
    private readonly opts: { secrets?: string[]; intervalMs?: number } = {},
  ) {}

  /** Feeds a chunk of stdout; lines may be split across chunks. */
  push(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    // A runaway line without a newline shouldn't grow forever.
    if (this.buffer.length > 64_000) this.buffer = this.buffer.slice(-64_000);
    for (const line of lines) this.line(line);
  }

  private line(raw: string): void {
    const line = raw.replace(ANSI, "").replace(CONTROL, "").trimEnd();
    if (TOOL_LINE.test(line)) {
      this.toolCalls++;
      this.inFence = false; // a tool call ends the text block it followed
      return;
    }
    if (/^\s*(?:```|~~~)/.test(line)) {
      this.inFence = !this.inFence;
      return;
    }
    if (this.inFence || !/\p{L}/u.test(line)) return;
    const note = lastSentence(this.scrub(line));
    if (note) this.note = note;
  }

  private scrub(text: string): string {
    let out = text;
    for (const s of this.opts.secrets ?? []) if (s) out = out.split(s).join("[redacted]");
    return redactSecrets(out.replace(BUILD_TOKEN, "[redacted]"));
  }

  /** True when the last snapshot is at least an interval old (or there hasn't been one). */
  due(now: number): boolean {
    return now - this.lastEmit >= (this.opts.intervalMs ?? PROGRESS_INTERVAL_MS);
  }

  /** Marks a snapshot as taken now. */
  taken(now: number): void {
    this.lastEmit = now;
  }

  snapshot(base: { attempt: number; startedAt: Date; budgetUsd: number; spentUsd: number | null }, now: Date): BuildProgress {
    return {
      attempt: base.attempt,
      startedAt: base.startedAt.toISOString(),
      updatedAt: now.toISOString(),
      note: this.note,
      toolCalls: this.toolCalls,
      spentUsd: base.spentUsd,
      budgetUsd: base.budgetUsd,
    };
  }
}

/**
 * Calls `report` on `tick`s at most once per interval, never twice at once. `tick` is cheap to
 * call often (the worker calls it on a short timer); a slow or failing report never stalls it.
 */
export function throttled(tracker: ProgressTracker, report: (now: number) => Promise<void>): (now: number) => Promise<void> {
  let busy = false;
  return async (now) => {
    if (busy || !tracker.due(now)) return;
    busy = true;
    tracker.taken(now);
    try {
      await report(now);
    } catch (error) {
      console.error("build progress:", error instanceof Error ? error.message : error);
    } finally {
      busy = false;
    }
  };
}
