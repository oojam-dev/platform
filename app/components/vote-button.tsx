import { useEffect, useRef, useState } from "react";
import { Link, useFetcher, useLocation } from "react-router";

import { CsrfInput } from "~/components/ui";
import { useRootData } from "~/lib/root-data";

export interface VoteState {
  ideaId: number;
  title: string;
  voteCount: number;
  /** The viewer's votes on this idea. */
  mine: number;
  /** Whether the idea is taking votes at all (open and screened). */
  open: boolean;
  /** Why it isn't, when `open` is false. */
  closedReason?: string;
}

type VoteResult = { ok: true; voteCount: number; mine: number } | { ok: false; error: string };

function useHydrated() {
  const [h, setH] = useState(false);
  useEffect(() => setH(true), []);
  return h;
}

/** Why the viewer can't vote right now, or null if they can. */
function blocker(
  root: ReturnType<typeof useRootData>,
  v: { open: boolean; mine: number; closedReason?: string },
): { reason: string; link?: { to: string; label: string } } | null {
  const cap = root?.rules.maxVotes ?? 10;
  if (!v.open) return { reason: v.closedReason ?? "This idea isn't taking votes." };
  if (!root?.user) return { reason: "Sign in with GitHub to vote.", link: { to: "", label: "Sign in" } };
  if (root.user.bannedAt) return { reason: "Your account is suspended." };
  if (v.mine >= cap) return { reason: `You've put the maximum ${cap} votes on this.` };
  if (root.user.balanceCents < 100) return { reason: "You need $1 of credit to vote.", link: { to: "/wallet", label: "Top up" } };
  return null;
}

export function VoteButton({ state, variant = "row" }: { state: VoteState; variant?: "row" | "large" }) {
  const root = useRootData();
  const fetcher = useFetcher<VoteResult>();
  const location = useLocation();
  const hydrated = useHydrated();
  const here = location.pathname + location.search;
  const cap = root?.rules.maxVotes ?? 10;

  const pending = fetcher.state !== "idle" && fetcher.formData != null;
  const failed = fetcher.state === "idle" && fetcher.data && !fetcher.data.ok ? fetcher.data.error : null;
  // Optimistic: count the vote while it's in flight and until the loaders revalidate.
  const count = state.voteCount + (pending ? 1 : 0);
  const mine = state.mine + (pending ? 1 : 0);
  const block = blocker(root, { open: state.open, mine, closedReason: state.closedReason });

  // A little bounce when the number changes.
  const [bump, setBump] = useState(0);
  const last = useRef(count);
  useEffect(() => {
    if (count !== last.current) {
      last.current = count;
      setBump((b) => b + 1);
    }
  }, [count]);

  const signIn = `/auth/github?return=${encodeURIComponent(here)}`;

  const countEl = (
    <span
      key={bump}
      aria-live="polite"
      aria-atomic="true"
      className={`num font-display font-black tracking-tight ${bump ? "pop" : ""} ${variant === "large" ? "text-6xl" : "text-2xl"}`}
    >
      {count.toLocaleString("en-US")}
      <span className="sr-only"> {count === 1 ? "vote" : "votes"}</span>
    </span>
  );

  const button = (() => {
    const label = variant === "large" ? "Vote +1 · $1" : "+1";
    const cls = `btn btn-jam ${variant === "large" ? "w-full" : "btn-sm min-w-[3.25rem] px-3"}`;
    if (block?.link) {
      return (
        <Link
          to={block.link.to || signIn}
          className={cls}
          aria-label={`${block.reason} ${block.link.label}`}
          title={block.reason}
        >
          {variant === "large" ? `${block.link.label} to vote` : label}
        </Link>
      );
    }
    return (
      <fetcher.Form method="post" action={`/ideas/${state.ideaId}/vote`} className={variant === "large" ? "w-full" : ""}>
        <CsrfInput />
        <input type="hidden" name="return" value={here} />
        {hydrated && <input type="hidden" name="js" value="1" />}
        <button
          type="submit"
          className={cls}
          disabled={Boolean(block) || pending}
          title={block?.reason ?? `Spend $1 to vote for “${state.title}”`}
          aria-label={block ? block.reason : `Vote for “${state.title}” for $1`}
        >
          {pending ? "…" : label}
        </button>
      </fetcher.Form>
    );
  })();

  if (variant === "row") {
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
        ) : block ? (
          block.reason
        ) : (
          <>
            Yours: <span className="num font-semibold text-ink">{mine}</span>/{cap}
          </>
        )}
      </p>
      {block && root?.user && state.open && (
        <p className="mt-1 text-xs text-ink-3">
          Yours: <span className="num">{mine}</span>/{cap}
        </p>
      )}
    </div>
  );
}
