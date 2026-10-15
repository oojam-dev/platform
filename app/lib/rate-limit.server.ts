/**
 * A small in-memory sliding-window limiter, per key. Good enough for one web process; it
 * protects counters (like share clicks) from being inflated by a script, not money.
 */
const buckets = new Map<string, number[]>();
let lastSweep = Date.now();

export function rateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  if (now - lastSweep > 60_000) {
    for (const [k, hits] of buckets) if (!hits.length || now - hits[hits.length - 1]! > windowMs) buckets.delete(k);
    lastSweep = now;
  }
  const hits = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);
  if (hits.length >= limit) {
    buckets.set(key, hits);
    return false;
  }
  hits.push(now);
  buckets.set(key, hits);
  return true;
}

/** The client IP: Caddy's X-Forwarded-For first hop, else whatever the socket says. */
export function clientIp(request: Request): string {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  return request.headers.get("x-real-ip") ?? "unknown";
}
