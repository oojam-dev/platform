/** The UTC calendar day, YYYY-MM-DD. */
export function utcDay(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

/** The next 00:00 UTC after `now`. */
export function nextFreeze(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}
