import { useEffect, useState } from "react";

import { clock } from "~/lib/format";

/**
 * Counts down to the next 00:00 UTC freeze. The first render uses the server's clock so
 * SSR and hydration match; after that it ticks on the client's clock.
 */
export function Countdown({ target, serverNow, paused }: { target: string; serverNow: number; paused: boolean }) {
  const end = Date.parse(target);
  const [now, setNow] = useState(serverNow);

  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Past midnight: roll over to the next one rather than sitting at 00:00:00.
  let remaining = (end - now) / 1000;
  while (remaining < 0) remaining += 86_400;

  return (
    <span className="inline-flex items-center gap-1.5" title="Voting freezes and the top idea is built at 00:00 UTC every day">
      <span className="text-ink-3">{paused ? "Cycle paused" : "Next build in"}</span>
      <time
        dateTime={target}
        className={`num font-mono font-semibold ${paused ? "text-ink-3 line-through" : "text-ink"}`}
        suppressHydrationWarning
      >
        {clock(remaining)}
      </time>
    </span>
  );
}
