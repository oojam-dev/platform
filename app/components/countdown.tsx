import { useEffect, useRef, useState } from "react";
import { Link, useRevalidator } from "react-router";

import { clock } from "~/lib/format";

/**
 * Seconds until `target`. The first render uses the server's clock (`serverNow`) so SSR and
 * hydration produce the same string; after mount it ticks on the client's clock. When it hits
 * zero it revalidates once, so the next build time comes from the server.
 */
export function useCountdown(target: string, serverNow: number): number {
  const end = Date.parse(target);
  const [now, setNow] = useState(serverNow);
  const revalidator = useRevalidator();
  const fired = useRef<string | null>(null);

  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const remaining = Math.max(0, Math.ceil((end - now) / 1000));

  useEffect(() => {
    if (remaining > 0 || fired.current === target) return;
    fired.current = target;
    const t = setTimeout(() => revalidator.revalidate(), 3000);
    return () => clearTimeout(t);
  }, [remaining, target, revalidator]);

  return remaining;
}

/** "00:00 UTC" for the freeze time. */
function utcTime(target: string): string {
  const d = new Date(target);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`;
}

/** The small one in the header. */
export function Countdown({ target, serverNow, paused }: { target: string; serverNow: number; paused: boolean }) {
  const remaining = useCountdown(target, serverNow);
  return (
    <span className="inline-flex items-center gap-1.5" title={`Voting freezes and the top idea is built at ${utcTime(target)}`}>
      <span className="text-ink-3">{paused ? "Cycle paused" : "Next build in"}</span>
      <time dateTime={target} className={`num font-mono font-semibold ${paused ? "text-ink-3 line-through" : "text-ink"}`}>
        {clock(remaining)}
      </time>
    </span>
  );
}

export interface Leader {
  id: number;
  title: string;
  voteCount: number;
}

/** The big one on the board: what happens when it reaches zero, and what would be built. */
export function BigCountdown({
  target,
  serverNow,
  paused,
  leader,
}: {
  target: string;
  serverNow: number;
  paused: { paused: boolean; reason: string };
  leader: Leader | null;
}) {
  const remaining = useCountdown(target, serverNow);
  const [h, m, s] = clock(remaining).split(":");
  const at = utcTime(target);

  if (paused.paused) {
    return (
      <section aria-labelledby="countdown-title" className="card overflow-hidden border-transparent bg-ink p-6 text-paper sm:p-8">
        <p className="kicker text-paper/70">Next build</p>
        <h2 id="countdown-title" className="mt-2 flex items-center gap-3 font-display text-5xl font-black tracking-tight sm:text-6xl">
          <span aria-hidden="true" className="inline-flex gap-1.5">
            <span className="h-10 w-3 rounded bg-jam sm:h-12" />
            <span className="h-10 w-3 rounded bg-jam sm:h-12" />
          </span>
          Paused
        </h2>
        <p className="mt-4 max-w-xl leading-relaxed opacity-85">
          {paused.reason ? <>“{paused.reason}” </> : null}
          No idea will be frozen or built until the admins resume the cycle. Voting stays open, so the board keeps
          moving.
        </p>
      </section>
    );
  }

  const unit = (value: string | undefined, label: string) => (
    <div className="flex flex-col items-center">
      <span className="num rounded-2xl bg-paper/10 px-2.5 py-1 font-mono text-5xl font-bold tracking-tight tabular-nums sm:px-4 sm:text-7xl">
        {value}
      </span>
      <span className="mt-2 text-[0.6875rem] font-bold uppercase tracking-[0.14em] opacity-70">{label}</span>
    </div>
  );

  return (
    <section aria-labelledby="countdown-title" className="card overflow-hidden border-transparent bg-ink p-6 text-paper sm:p-8">
      <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0 lg:max-w-md">
          <h2 id="countdown-title" className="kicker text-paper/70">
            Next build in
          </h2>
          <p className="mt-3 leading-relaxed opacity-90">
            {remaining > 0 ? (
              <>
                At <strong className="font-bold">{at}</strong> the top idea freezes and Claude starts building it.
              </>
            ) : (
              <>Freezing the top idea now — Claude is starting to build it.</>
            )}
          </p>
          <div className="mt-5 rounded-2xl bg-paper/10 p-4">
            <p className="text-[0.6875rem] font-bold uppercase tracking-[0.14em] text-jam">
              {remaining > 0 ? "If voting closed now" : "Being frozen"}
            </p>
            {leader ? (
              <Link to={`/ideas/${leader.id}`} className="mt-1 block font-display text-lg font-black leading-snug hover:underline">
                {leader.title}
                <span className="num ml-2 text-sm font-semibold opacity-70">
                  {leader.voteCount} {leader.voteCount === 1 ? "vote" : "votes"}
                </span>
              </Link>
            ) : (
              <p className="mt-1 text-sm opacity-85">
                Nothing on the board yet — the first idea posted will be it.
              </p>
            )}
          </div>
        </div>
        <time
          dateTime={target}
          aria-label={`${Number(h)} hours, ${Number(m)} minutes and ${Number(s)} seconds until the next build`}
          className="flex items-start justify-center gap-1.5 sm:gap-3"
        >
          {unit(h, "hours")}
          <span aria-hidden="true" className="pt-2 font-mono text-4xl font-bold text-jam sm:text-6xl">
            :
          </span>
          {unit(m, "min")}
          <span aria-hidden="true" className="pt-2 font-mono text-4xl font-bold text-jam sm:text-6xl">
            :
          </span>
          {unit(s, "sec")}
        </time>
      </div>
    </section>
  );
}
