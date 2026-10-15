import { useEffect, useRef, useState } from "react";
import { Link, useFetcher, useLocation } from "react-router";

import { CsrfInput } from "~/components/ui";
import { useRootData } from "~/lib/root-data";

export interface VoteState {
  ideaId: number;
  title: string;
  voteCount: number;
  /** Whether the viewer has voted for it. */
  voted: boolean;
  /** Whether the idea is taking votes at all (open and screened). */
  open: boolean;
  /** Why it isn't, when `open` is false. */
  closedReason?: string;
}

type VoteResult = { ok: true; voteCount: number; voted: boolean } | { ok: false; error: string };

function useHydrated() {
  const [h, setH] = useState(false);
  useEffect(() => setH(true), []);
  return h;
}

function Arrow({ filled, size = 14 }: { filled: boolean; size?: number }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" width={size} height={size} className="shrink-0">
      <path
        d="M8 2.5 14 10H10v3.5H6V10H2z"
        fill={filled ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * The upvote toggle: one vote per person per idea, which they can take back while the idea is
 * open. Optimistic via a fetcher; without JavaScript it's a plain form post that redirects back.
 */
export function VoteButton({ state, variant = "row" }: { state: VoteState; variant?: "row" | "large" }) {
  const root = useRootData();
  const fetcher = useFetcher<VoteResult>();
  const location = useLocation();
  const hydrated = useHydrated();
  const here = location.pathname + location.search;
  const large = variant === "large";

  const pendingIntent = fetcher.state !== "idle" ? fetcher.formData?.get("intent") : undefined;
  const failed = fetcher.state === "idle" && fetcher.data && !fetcher.data.ok ? fetcher.data.error : null;
  // Optimistic: flip the vote while it's in flight and until the loaders revalidate.
  const voted = pendingIntent ? pendingIntent === "vote" : state.voted;
  const delta = pendingIntent && voted !== state.voted ? (voted ? 1 : -1) : 0;
  const count = state.voteCount + delta;

  const [bump, setBump] = useState(0);
  const last = useRef(count);
  useEffect(() => {
    if (count !== last.current) {
      last.current = count;
      setBump((b) => b + 1);
    }
  }, [count]);

  const signedIn = Boolean(root?.user);
  const banned = Boolean(root?.user?.bannedAt);
  const reason = !state.open
    ? (state.closedReason ?? "This idea isn't taking votes.")
    : !signedIn
      ? "Sign in with GitHub to vote — it's free."
      : banned
        ? "Your account is suspended."
        : voted
          ? "You voted for this. Click again to take your vote back."
          : null;

  const countEl = (
    <span
      key={bump}
      aria-live="polite"
      aria-atomic="true"
      className={`num font-display font-black tracking-tight ${bump ? "pop" : ""} ${large ? "text-6xl" : "text-2xl"}`}
    >
      {count.toLocaleString("en-US")}
      <span className="sr-only"> {count === 1 ? "vote" : "votes"}</span>
    </span>
  );

  const base = large ? "btn w-full py-3 text-base" : "btn btn-sm min-w-[3.5rem] gap-1 px-3";
  const look = voted ? "bg-jam text-on-jam hover:bg-jam-hover" : "btn-ghost text-jam-ink hover:border-jam";
  const label = large ? (voted ? "Voted" : "Vote") : voted ? "Voted" : "Vote";

  let button;
  if (!signedIn && state.open) {
    button = (
      <Link
        to={`/auth/github?return=${encodeURIComponent(here)}`}
        className={`${base} btn-ghost text-jam-ink hover:border-jam`}
        aria-label={`Sign in to vote for “${state.title}”`}
        title="Sign in with GitHub to vote — it's free."
      >
        <Arrow filled={false} size={large ? 18 : 14} />
        {large ? "Sign in to vote" : "Vote"}
      </Link>
    );
  } else {
    const disabled = !state.open || banned || fetcher.state === "submitting";
    button = (
      <fetcher.Form method="post" action={`/ideas/${state.ideaId}/vote`} className={large ? "w-full" : ""}>
        <CsrfInput />
        <input type="hidden" name="intent" value={voted ? "unvote" : "vote"} />
        <input type="hidden" name="return" value={here} />
        {hydrated && <input type="hidden" name="js" value="1" />}
        <button
          type="submit"
          className={`${base} ${look}`}
          disabled={disabled}
          aria-pressed={voted}
          title={reason ?? `Vote for “${state.title}”`}
          aria-label={`${voted ? "Voted for" : "Vote for"} “${state.title}”`}
        >
          <Arrow filled={voted} size={large ? 18 : 14} />
          {label}
        </button>
      </fetcher.Form>
    );
  }

  if (!large) {
    return (
      <div className="flex w-16 shrink-0 flex-col items-center gap-1.5 sm:w-[4.5rem]">
        {countEl}
        {button}
        {failed && (
          <span role="alert" className="text-center text-[0.6875rem] leading-tight text-warn">
            {failed}
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center text-center">
      {countEl}
      <span className="mt-1 text-sm font-semibold text-ink-3">{count === 1 ? "vote" : "votes"}</span>
      <div className="mt-5 w-full">{button}</div>
      <p className="mt-3 text-sm text-ink-2" aria-live="polite">
        {failed ? (
          <span className="text-warn">{failed}</span>
        ) : (
          (reason ?? "Free. One vote per person, and you can take it back while voting's open.")
        )}
      </p>
    </div>
  );
}
