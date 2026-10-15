import { Cron } from "croner";

/** The UTC calendar day, YYYY-MM-DD. */
export function utcDay(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

/** 00:00 UTC on the day of `d`: when daily vote allowances reset. */
export function startOfUtcDay(d = new Date()): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** The next 00:00 UTC after `now`. */
export function nextUtcMidnight(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}

/** When the next build starts, from the worker's cron (default every day at 00:00 UTC). */
export function nextBuildAt(cron: string, now = new Date()): Date {
  try {
    return new Cron(cron, { timezone: "UTC", paused: true }).nextRun(now) ?? nextUtcMidnight(now);
  } catch {
    return nextUtcMidnight(now);
  }
}

/** Kept for the UI: the next freeze is the next build. */
export function nextFreeze(now = new Date()): Date {
  return nextBuildAt(process.env.CYCLE_CRON || "0 0 * * *", now);
}
