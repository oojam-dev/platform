/** Live updates on /builds/:id while a build is in flight. */
import { useEffect, useRef, useState } from "react";
import { useRevalidator } from "react-router";

/** Statuses where the build page refreshes itself; every other status is final or waiting. */
export const LIVE_STATUSES: ReadonlySet<string> = new Set(["screening", "building", "gating", "pr_open", "merging", "deploying"]);
export const POLL_MS = 15_000;

export function isLive(status: string): boolean {
  return LIVE_STATUSES.has(status);
}

/** Revalidates the route every `ms` while `active`, skipping hidden tabs and overlapping loads. */
export function useRevalidateWhile(active: boolean, ms = POLL_MS): void {
  const revalidator = useRevalidator();
  // A new revalidator comes with every render; keep the interval steady across them.
  const latest = useRef(revalidator);
  latest.current = revalidator;
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => {
      const r = latest.current;
      if (document.visibilityState === "visible" && r.state === "idle") void r.revalidate();
    }, ms);
    return () => clearInterval(t);
  }, [active, ms]);
}

/** The time, ticking every second while `active`. Starts at the server's clock so SSR and hydration agree. */
export function useNow(serverNow: number, active: boolean): number {
  const [now, setNow] = useState(serverNow);
  useEffect(() => {
    setNow(Date.now());
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}
