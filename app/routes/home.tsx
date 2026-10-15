import { Link, NavLink } from "react-router";

import { listBoard, topOpenIdea, type BoardSort } from "../../src/core/ideas.js";
import { topSharers } from "../../src/core/referrals.js";
import { votedOn } from "../../src/core/votes.js";
import { getDb } from "../../src/db/client.js";
import { BigCountdown } from "../components/countdown";
import { ShareButton } from "../components/share";
import { Author, Avatar, EmptyState, SponsorCard, StatusChip } from "../components/ui";
import { VoteButton } from "../components/vote-button";
import { VoteNotice } from "../components/vote-notice";
import { ago, plural } from "../lib/format";
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
  const [user, items, top, sharers] = await Promise.all([
    optionalUser(request),
    listBoard(db, tab, 100),
    topOpenIdea(db),
    topSharers(db, 5, 30),
  ]);
  const voted = user ? [...(await votedOn(db, user.id, items.map((i) => i.id)))] : [];
  const leader = top ? { id: top.id, title: top.title, voteCount: top.voteCount } : null;
  return { tab, items, voted, leader, sharers, viewer: user?.githubLogin ?? null, now: Date.now() };
}

export default function Home({ loaderData }: Route.ComponentProps) {
  const { tab, items, voted, leader, sharers, viewer, now } = loaderData;
  const root = useRootData();
  const votedSet = new Set(voted);

  return (
    <>
      <section className="mb-8 grid gap-8 lg:grid-cols-[1fr_auto] lg:items-end">
        <div className="max-w-3xl">
          <p className="kicker mb-3">The community decides what oojam.dev becomes</p>
          <h1 className="font-display text-[2.4rem] font-black leading-[0.98] tracking-[-0.035em] text-balance sm:text-6xl">
            Vote for free. <span className="text-jam">Steer a website.</span>
          </h1>
          <p className="mt-5 max-w-2xl text-lg leading-relaxed text-ink-2 text-pretty">
            Post an idea, vote for the ones you like, share them with friends — it's all free. Every night at 00:00&nbsp;UTC the top idea is frozen,
            built by Claude, merged into the open-source repo and deployed to{" "}
            <a href="https://oojam.dev" className="link">
              oojam.dev
            </a>
            . Just a bit of fun.
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          <Link to="/ideas/new" className="btn btn-jam px-5 py-3 text-base">
            Post an idea
          </Link>
          <Link to="/rules" className="btn btn-ghost px-5 py-3 text-base">
            How it works
          </Link>
        </div>
      </section>

      {root && (
        <div className="mb-12">
          <BigCountdown target={root.nextFreezeAt} serverNow={root.serverNow} paused={root.paused} leader={leader} />
        </div>
      )}

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
                    Post the first idea
                  </Link>
                }
              >
                oojam.dev has no purpose until someone gives it one. Whatever sits on top at midnight UTC gets built by
                Claude and shipped — and right now, a single vote puts you on top.
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
                          voted: votedSet.has(item.id),
                          open: votable,
                          closedReason: "Voting closed when this idea was frozen.",
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
                        {item.status !== "open" && <StatusChip status={item.status} />}
                      </div>
                    </div>
                    <div className="shrink-0 self-start">
                      <ShareButton
                        ideaId={item.id}
                        title={item.title}
                        isAuthor={viewer !== null && viewer.toLowerCase() === item.author.toLowerCase()}
                        variant="icon"
                      />
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </section>

        <div className="space-y-4 lg:sticky lg:top-6 lg:self-start">
          <HowItWorks />
          <TopSharers sharers={sharers} />
          {root && <SponsorCard url={root.sponsorUrl} compact />}
        </div>
      </div>
    </>
  );
}

function HowItWorks() {
  const root = useRootData();
  const ideas = root?.rules.maxIdeasPerDay ?? 1;
  const steps = [
    { big: "Free", text: "Vote for as many ideas as you like — one vote each. Changed your mind? Take it back." },
    { big: `${ideas}/day`, text: "Post one idea a day. Posting counts as your vote for it." },
    { big: "Share", text: "Your share link credits you for every vote it brings in." },
    { big: "00:00", text: "UTC every day, the top idea freezes and Claude builds it." },
    { big: "Ship", text: "Guardrails check it, then it's merged and deployed automatically." },
  ];
  return (
    <aside aria-labelledby="how-title" className="card p-6">
      <h2 id="how-title" className="font-display text-xl font-black tracking-tight">
        How it works
      </h2>
      <ol className="mt-5 space-y-4">
        {steps.map((s) => (
          <li key={s.big} className="flex gap-3">
            <span className="num w-16 shrink-0 font-display text-lg font-black text-jam">{s.big}</span>
            <span className="text-sm leading-relaxed text-ink-2">{s.text}</span>
          </li>
        ))}
      </ol>
      <p className="mt-5 border-t border-line pt-4 text-xs leading-relaxed text-ink-3">
        No payments, no wallets. Ideas are screened against the{" "}
        <Link to="/rules" className="link">
          content policy
        </Link>
        ; if one's rejected, it doesn't count as your idea for the day.
      </p>
    </aside>
  );
}

function TopSharers({ sharers }: { sharers: { login: string; avatarUrl: string | null; voters: number }[] }) {
  if (sharers.length === 0) return null;
  return (
    <section aria-labelledby="sharers-title" className="card p-6">
      <h2 id="sharers-title" className="font-display text-lg font-black tracking-tight">
        Top sharers
      </h2>
      <p className="mt-0.5 text-xs text-ink-3">Voters brought in through share links, last 30 days</p>
      <ol className="mt-4 space-y-3">
        {sharers.map((s, i) => (
          <li key={s.login} className="flex items-center gap-3 text-sm">
            <span className="num w-4 text-right font-bold text-ink-3">{i + 1}</span>
            <Avatar src={s.avatarUrl} login={s.login} size={26} />
            <a
              href={`https://github.com/${encodeURIComponent(s.login)}`}
              rel="nofollow noopener"
              className="min-w-0 flex-1 truncate font-semibold hover:underline"
            >
              @{s.login}
            </a>
            <span className="num shrink-0 font-semibold text-jam-ink">{s.voters}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
