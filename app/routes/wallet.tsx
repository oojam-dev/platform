import { Form, Link, useNavigation } from "react-router";

import { TOPUP_MAX_CENTS, TOPUP_MIN_CENTS, TOPUP_PRESETS_CENTS } from "../../src/core/config.js";
import { walletBalance } from "../../src/core/ledger.js";
import { walletHistory } from "../../src/core/stats.js";
import { getDb } from "../../src/db/client.js";
import type { WalletKind } from "../../src/db/schema.js";
import { CsrfInput, Notice, PageTitle } from "../components/ui";
import { credits, dateTime, money, signedMoney } from "../lib/format";
import { ideaTitles, pendingTopups } from "../lib/queries.server";
import { requireUser } from "../lib/session.server";
import type { Route } from "./+types/wallet";

export const meta: Route.MetaFunction = () => [{ title: "Wallet · oojam build" }];

export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireUser(request);
  const db = getDb();
  const [balanceCents, history, pending] = await Promise.all([
    walletBalance(db, user.id),
    walletHistory(db, user.id, 200),
    pendingTopups(db, user.id),
  ]);
  const titles = await ideaTitles(
    db,
    history.map((h) => h.ideaId).filter((x): x is number => x != null),
  );
  const url = new URL(request.url);
  return {
    balanceCents,
    history: history.map((h) => ({
      id: h.id,
      kind: h.kind,
      deltaCents: h.deltaCents,
      ideaId: h.ideaId,
      note: h.note,
      createdAt: h.createdAt,
    })),
    titles,
    pending,
    topup: url.searchParams.get("topup"),
    code: url.searchParams.get("code"),
    banned: Boolean(user.bannedAt),
  };
}

const KIND_LABEL: Record<WalletKind, string> = {
  topup: "Top-up",
  post: "Posted an idea",
  vote: "Voted",
  refund: "Refund",
  adjustment: "Adjustment",
};

function TopupNotice({ topup, code }: { topup: string | null; code: string | null }) {
  if (topup === "success") {
    return (
      <Notice tone="ok" title="Payment received — thank you!" className="mb-8">
        Stripe confirms payments to us separately, so your credit can take a few seconds to show up. Refresh if it
        isn't here yet.
      </Notice>
    );
  }
  if (topup === "cancelled") {
    return (
      <Notice tone="info" title="Checkout cancelled." className="mb-8">
        Nothing was charged.
      </Notice>
    );
  }
  if (topup === "error") {
    const msg =
      code === "invalid"
        ? `Top up a whole number of dollars between ${money(TOPUP_MIN_CENTS)} and ${money(TOPUP_MAX_CENTS)}.`
        : code === "banned"
          ? "This account is suspended, so it can't top up."
          : "We couldn't reach Stripe just now. Nothing was charged — please try again in a minute.";
    return (
      <Notice tone="warn" title="That top-up didn't start." className="mb-8">
        {msg}
      </Notice>
    );
  }
  return null;
}

export default function Wallet({ loaderData }: Route.ComponentProps) {
  const { balanceCents, history, titles, pending, topup, code, banned } = loaderData;
  const nav = useNavigation();
  const busy = nav.state !== "idle" && nav.formAction === "/wallet/topup";
  const busyAmount = busy ? String(nav.formData?.get("amount") ?? "") : null;

  return (
    <>
      <PageTitle kicker="Your wallet" title="Credits for ideas and votes">
        1 credit = $1. Posting an idea or casting a vote commits one credit. Unspent credit never expires.
      </PageTitle>

      <TopupNotice topup={topup} code={code} />

      <div className="grid gap-8 lg:grid-cols-[22rem_minmax(0,1fr)] lg:gap-12">
        <div className="space-y-4">
          <div className="card border-transparent bg-ink p-6 text-paper">
            <p className="text-xs font-bold tracking-wider uppercase opacity-70">Balance</p>
            <p className="num mt-2 font-display text-6xl font-black tracking-tight">{credits(balanceCents)}</p>
            <p className="mt-1 text-sm opacity-70">
              {balanceCents % 100 !== 0 ? `${money(balanceCents)} exactly · ` : ""}
              {Math.floor(Math.max(0, balanceCents) / 100)} posts or votes
            </p>
          </div>

          {!banned && (
            <div className="card p-6">
              <h2 className="font-display text-lg font-black tracking-tight">Top up</h2>
              <p className="mt-1 text-sm text-ink-2">Secure checkout by Stripe. You'll come straight back here.</p>
              <Form method="post" action="/wallet/topup" className="mt-4 grid grid-cols-3 gap-2">
                <CsrfInput />
                {TOPUP_PRESETS_CENTS.map((c) => (
                  <button
                    key={c}
                    type="submit"
                    name="amount"
                    value={String(c / 100)}
                    className="btn btn-ghost num py-3 text-base"
                    disabled={busy}
                  >
                    {busyAmount === String(c / 100) ? "…" : `$${c / 100}`}
                  </button>
                ))}
              </Form>
              <Form method="post" action="/wallet/topup" className="mt-4">
                <CsrfInput />
                <label htmlFor="amount" className="label">
                  Custom amount
                </label>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <span aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-3">
                      $
                    </span>
                    <input
                      id="amount"
                      name="amount"
                      type="number"
                      inputMode="numeric"
                      min={TOPUP_MIN_CENTS / 100}
                      max={TOPUP_MAX_CENTS / 100}
                      step={1}
                      required
                      placeholder="50"
                      className="field num pl-7"
                      aria-describedby="amount-help"
                    />
                  </div>
                  <button type="submit" className="btn btn-jam" disabled={busy}>
                    {busy && busyAmount && !TOPUP_PRESETS_CENTS.some((c) => String(c / 100) === busyAmount)
                      ? "Opening…"
                      : "Top up"}
                  </button>
                </div>
                <p id="amount-help" className="mt-1.5 text-xs text-ink-3">
                  Whole dollars, {money(TOPUP_MIN_CENTS)}–{money(TOPUP_MAX_CENTS)}.
                </p>
              </Form>
              <p className="mt-5 border-t border-line pt-4 text-xs leading-relaxed text-ink-3">
                Committed credits (posts and votes) are non-refundable, except when screening rejects your idea — then
                the $1 comes back automatically. See the{" "}
                <Link to="/rules" className="link">
                  rules
                </Link>
                .
              </p>
            </div>
          )}

          <Form method="post" action="/auth/logout" className="sm:hidden">
            <CsrfInput />
            <button type="submit" className="btn btn-ghost btn-sm w-full">
              Sign out
            </button>
          </Form>

          {pending.length > 0 && (
            <p className="text-xs text-ink-3">
              {pending.length === 1 ? "One checkout" : `${pending.length} checkouts`} started but not confirmed by Stripe
              yet. If you completed payment, the credit will appear shortly.
            </p>
          )}
        </div>

        <section aria-labelledby="history-title">
          <h2 id="history-title" className="font-display text-xl font-black tracking-tight">
            History
          </h2>
          {history.length === 0 ? (
            <p className="mt-4 text-ink-2">Nothing yet. Your top-ups, posts and votes will show up here.</p>
          ) : (
            <ol className="card mt-4 divide-y divide-line">
              {history.map((h) => {
                const title = h.ideaId != null ? titles[h.ideaId] : undefined;
                return (
                  <li key={h.id} className="flex items-start justify-between gap-4 px-4 py-3.5 sm:px-5">
                    <div className="min-w-0">
                      <p className="font-semibold">
                        {KIND_LABEL[h.kind]}
                        {h.kind === "vote" || h.kind === "post" || h.kind === "refund" ? (
                          h.ideaId != null ? (
                            <>
                              {h.kind === "vote" ? " on " : h.kind === "refund" ? " for " : ": "}
                              <Link to={`/ideas/${h.ideaId}`} className="link font-normal">
                                {title ?? `idea #${h.ideaId}`}
                              </Link>
                            </>
                          ) : null
                        ) : null}
                      </p>
                      <p className="mt-0.5 text-xs text-ink-3">
                        {dateTime(h.createdAt)}
                        {h.note && h.kind !== "topup" ? ` · ${h.note}` : ""}
                      </p>
                    </div>
                    <span className={`num shrink-0 font-semibold ${h.deltaCents > 0 ? "text-ok" : "text-ink"}`}>
                      {signedMoney(h.deltaCents)}
                    </span>
                  </li>
                );
              })}
            </ol>
          )}
        </section>
      </div>
    </>
  );
}
