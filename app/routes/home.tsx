import { Link, NavLink } from "react-router";

import { listBoard, type BoardSort } from "../../src/core/ideas.js";
import { getDb } from "../../src/db/client.js";
import { StatusChip, Author, EmptyState } from "../components/ui";
import { VoteButton } from "../components/vote-button";
import { VoteNotice } from "../components/vote-notice";
import { ago, plural } from "../lib/format";
import { myVoteCounts } from "../lib/queries.server";
import { useRootData } from "../lib/root-data";
import { optionalUser } from "../lib/session.server";
import type { Route } from "./+types/home";

const TABS: { key: BoardSort; label: string }[] = [
  { key: "top", label: "Top" },
  { key: "new", label: "New" },
  { key: "built", label: "Built" },
];

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const raw = url.searchParams.get("tab");
  const tab: BoardSort = raw === "new" || raw === "built" ? raw : "top";
  const db = getDb();
  const [user, items] = await Promise.all([optionalUser(request), listBoard(db, tab, 100)]);
  const mine = user ? await myVoteCounts(db, user.id, items.map((i) => i.id)) : {};
  return { tab, items, mine, now: Date.now() };
}

export default function Home({ loaderData }: Route.ComponentProps) {
  const { tab, items, mine, now } = loaderData;
  const root = useRootData();

  return (
    <>
      <section className="mb-12 grid gap-8 lg:grid-cols-[1fr_auto] lg:items-end">
        <div className="max-w-3xl">
          <p className="kicker mb-3">The community decides what oojam.dev becomes</p>
          <h1 className="font-display text-[2.4rem] font-black leading-[0.98] tracking-[-0.035em] text-balance sm:text-6xl">
            Spend a dollar. <span className="text-jam">Steer a website.</span>
          </h1>
          <p className="mt-5 max-w-2xl text-lg leading-relaxed text-ink-2 text-pretty">
            Post an idea for $1, back the ones you like with $1 votes. Every night at 00:00&nbsp;UTC the top idea is
            frozen, built by Claude, merged into the open-source repo and deployed to{" "}
            <a href="https://oojam.dev" className="link">
              oojam.dev
            </a>
            .
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          <Link to="/ideas/new" className="btn btn-jam px-5 py-3 text-base">
            Post an idea — $1
          </Link>
          <Link to="/rules" className="btn btn-ghost px-5 py-3 text-base">
            How it works
          </Link>
        </div>
      </section>

      <VoteNotice />

      <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <section aria-labelledby="board-title">
          <div className="mb-4 flex items-center justify-between gap-4">
            <h2 id="board-title" className="sr-only">
              Ideas board
            </h2>
            <nav aria-label="Sort ideas" className="inline-flex rounded-full bg-sunk p-1">
              {TABS.map((t) => (
                <NavLink
                  key={t.key}
                  to={t.key === "top" ? "/" : `/?tab=${t.key}`}
                  aria-current={tab === t.key ? "page" : undefined}
                  className={`rounded-full px-4 py-1.5 text-sm font-semibold transition-colors ${
                    tab === t.key ? "bg-card text-ink shadow-sm" : "text-ink-2 hover:text-ink"
                  }`}
                  preventScrollReset
                >
                  {t.label}
                </NavLink>
              ))}
            </nav>
            <p className="hidden text-sm text-ink-3 sm:block">
              {tab === "top" && "Most votes first · ties go to the older idea"}
              {tab === "new" && "Newest first"}
              {tab === "built" && "Shipped to oojam.dev"}
            </p>
          </div>

          {items.length === 0 ? (
            tab === "built" ? (
              <EmptyState title="Nothing built yet.">
                The first build happens at the first 00:00 UTC after an idea has votes. It could be yours.
              </EmptyState>
            ) : (
              <EmptyState
                title="The board is empty. Go first."
                action={
                  <Link to="/ideas/new" className="btn btn-jam px-5 py-3 text-base">
                    Post the first idea — $1
                  </Link>
                }
              >
                oojam.dev has no purpose until someone gives it one. Whatever sits on top at midnight UTC gets built by
                Claude and shipped — and right now, one dollar puts you on top.
              </EmptyState>
            )
          ) : (
            <ol className="card divide-y divide-line overflow-hidden">
              {items.map((item, i) => {
                const votable = item.status === "open";
                const leader = tab === "top" && i === 0 && item.status === "open";
                return (
                  <li key={item.id} className={`flex gap-3 px-3 py-4 sm:gap-4 sm:px-5 ${leader ? "bg-jam-soft/50" : ""}`}>
                    {tab === "built" ? (
                      <div className="flex w-16 shrink-0 flex-col items-center sm:w-[4.5rem]">
                        <span className="num font-display text-2xl font-black">{item.voteCount}</span>
                        <span className="text-[0.6875rem] font-semibold uppercase text-ink-3">votes</span>
                      </div>
                    ) : (
                      <VoteButton
                        state={{
                          ideaId: item.id,
                          title: item.title,
                          voteCount: item.voteCount,
                          mine: mine[item.id] ?? 0,
                          open: votable,
                        }}
                      />
                    )}
                    <div className="min-w-0 flex-1 pt-0.5">
                      {leader && (
                        <p className="mb-1 text-[0.6875rem] font-bold uppercase tracking-wider text-jam-ink">
                          ★ Tonight's build, if voting closed now
                        </p>
                      )}
                      <h3 className="text-[1.0625rem] font-bold leading-snug text-pretty sm:text-lg">
                        <Link to={`/ideas/${item.id}`} className="hover:text-jam-ink hover:underline">
                          {item.title}
                        </Link>
                      </h3>
                      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.8125rem] text-ink-3">
                        <Author login={item.author} avatar={item.authorAvatar} />
                        <Link to={`/ideas/${item.id}#comments`} className="hover:text-ink">
                          {plural(item.commentCount, "comment")}
                        </Link>
                        <span>{ago(item.createdAt, now)}</span>
                        {mine[item.id] ? (
                          <span className="font-semibold text-jam-ink">
                            {mine[item.id]}/{root?.rules.maxVotes ?? 10} yours
                          </span>
                        ) : null}
                        {item.status !== "open" && <StatusChip status={item.status} />}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </section>

        <HowItWorks />
      </div>
    </>
  );
}

function HowItWorks() {
  const root = useRootData();
  const share = Math.round((root?.rules.buildShare ?? 0.8) * 100);
  const max = root?.rules.maxVotes ?? 10;
  const steps = [
    { big: "$1", text: "posts an idea or adds one vote. Posting includes your first vote." },
    { big: `${max}×`, text: `max votes per person on any one idea, so nobody can simply buy the board.` },
    { big: "00:00", text: "UTC every day, the top idea freezes and Claude builds it." },
    { big: "Ship", text: "Guardrails check it, then it's merged and deployed automatically." },
  ];
  return (
    <aside aria-labelledby="how-title" className="lg:sticky lg:top-6 lg:self-start">
      <div className="card p-6">
        <h2 id="how-title" className="font-display text-xl font-black tracking-tight">
          How it works
        </h2>
        <ol className="mt-5 space-y-4">
          {steps.map((s) => (
            <li key={s.big} className="flex gap-3">
              <span className="num w-14 shrink-0 font-display text-lg font-black text-jam">{s.big}</span>
              <span className="text-sm leading-relaxed text-ink-2">{s.text}</span>
            </li>
          ))}
        </ol>
        <div className="mt-6 border-t border-line pt-5">
          <p className="text-sm font-semibold">Where every committed dollar goes</p>
          <div className="mt-3 flex h-3 overflow-hidden rounded-full" role="img" aria-label={`${share}% build fund, ${100 - share}% hosting`}>
            <span className="bg-jam" style={{ width: `${share}%` }} />
            <span className="bg-line-strong" style={{ width: `${100 - share}%` }} />
          </div>
          <div className="mt-2 flex justify-between text-xs text-ink-2">
            <span>
              <strong className="text-ink">{share}%</strong> pays for builds
            </span>
            <span>
              <strong className="text-ink">{100 - share}%</strong> hosting
            </span>
          </div>
        </div>
        <p className="mt-5 text-xs leading-relaxed text-ink-3">
          Ideas are screened against the{" "}
          <Link to="/rules" className="link">
            content policy
          </Link>
          ; rejected ones are refunded. Spending is public on{" "}
          <Link to="/fund" className="link">
            /fund
          </Link>
          .
        </p>
      </div>
    </aside>
  );
}
