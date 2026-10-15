import { Form, Link } from "react-router";

import { config } from "../../src/core/config.js";
import { postsToday } from "../../src/core/votes.js";
import { getDb } from "../../src/db/client.js";
import { ShareButton } from "../components/share";
import { Avatar, CsrfInput, StatusChip } from "../components/ui";
import { ago, plural } from "../lib/format";
import { ideasByAuthor, myReferrals, votedIdeas } from "../lib/queries.server";
import { useRootData } from "../lib/root-data";
import { requireUser } from "../lib/session.server";
import type { Route } from "./+types/account";

export const meta: Route.MetaFunction = () => [{ title: "Your account · oojam build" }];

export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireUser(request);
  const db = getDb();
  const [today, ideas, voted, referrals] = await Promise.all([
    postsToday(db, user.id),
    ideasByAuthor(db, user.id),
    votedIdeas(db, user.id),
    myReferrals(db, user.id),
  ]);
  return {
    login: user.githubLogin,
    name: user.name,
    avatarUrl: user.avatarUrl,
    today,
    maxIdeas: config.maxIdeasPerDay,
    ideas,
    voted,
    referrals,
    now: Date.now(),
  };
}

export default function Account({ loaderData }: Route.ComponentProps) {
  const { login, name, avatarUrl, today, maxIdeas, ideas, voted, referrals, now } = loaderData;
  const root = useRootData();
  const canPost = today.posts < maxIdeas;

  return (
    <>
      <div className="mb-10 flex items-center gap-4">
        <Avatar src={avatarUrl} login={login} size={56} />
        <div className="min-w-0">
          <p className="kicker">Your account</p>
          <h1 className="truncate font-display text-3xl font-black tracking-tight">{name ?? `@${login}`}</h1>
          {name && <p className="text-sm text-ink-3">@{login}</p>}
        </div>
      </div>

      <div className="grid gap-8 lg:grid-cols-[20rem_minmax(0,1fr)] lg:gap-12">
        <div className="space-y-4">
          <div className="card border-transparent bg-ink p-6 text-paper">
            <p className="text-xs font-bold tracking-wider uppercase opacity-70">Your shares brought in</p>
            <p className="mt-2 flex items-baseline gap-2 font-display font-black tracking-tight">
              <span className="num text-6xl">{referrals.votes}</span>
              <span className="text-xl opacity-70">{referrals.votes === 1 ? "vote" : "votes"}</span>
            </p>
            <p className="mt-1 text-sm opacity-75">
              and {plural(referrals.signups, "new member")}. Share any idea and your link credits you.
            </p>
          </div>

          <div className="card p-5 text-sm">
            <p className="font-semibold">{canPost ? "You can post an idea today." : "You've posted today's idea."}</p>
            <p className="mt-1 text-ink-2">
              {canPost
                ? `${maxIdeas === 1 ? "One idea" : `${maxIdeas} ideas`} a day; posting counts as your vote for it.`
                : "You can post again after 00:00 UTC."}
            </p>
            {canPost && (
              <Link to="/ideas/new" className="btn btn-jam btn-sm mt-4">
                Post an idea
              </Link>
            )}
          </div>

          <Form method="post" action="/auth/logout">
            <CsrfInput />
            <button type="submit" className="btn btn-ghost w-full">
              Sign out
            </button>
          </Form>
          {root?.user?.isAdmin && (
            <Link to="/admin" className="block text-center text-sm font-semibold text-ink-2 hover:text-ink">
              Admin control room →
            </Link>
          )}
        </div>

        <div className="min-w-0 space-y-12">
          <section aria-labelledby="mine-title">
            <h2 id="mine-title" className="font-display text-xl font-black tracking-tight">
              Your ideas
            </h2>
            {ideas.length === 0 ? (
              <p className="mt-3 text-ink-2">
                Nothing yet.{" "}
                <Link to="/ideas/new" className="link">
                  Post your first idea
                </Link>
                .
              </p>
            ) : (
              <ol className="card mt-4 divide-y divide-line">
                {ideas.map((i) => (
                  <li key={i.id} className="flex items-center justify-between gap-3 px-4 py-3.5 sm:px-5">
                    <div className="min-w-0">
                      <Link to={`/ideas/${i.id}`} className="font-semibold hover:underline">
                        {i.title}
                      </Link>
                      <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-ink-3">
                        <span>{ago(i.createdAt, now)}</span>
                        <span>· {plural(i.voteCount, "vote")}</span>
                        <StatusChip
                          status={i.hiddenAt ? "hidden" : i.status === "open" && !i.screened ? "screening" : i.status}
                        />
                      </p>
                    </div>
                    {!i.hiddenAt && i.status === "open" && i.screened && (
                      <ShareButton ideaId={i.id} title={i.title} isAuthor variant="icon" />
                    )}
                  </li>
                ))}
              </ol>
            )}
          </section>

          <section aria-labelledby="voted-title">
            <h2 id="voted-title" className="font-display text-xl font-black tracking-tight">
              Ideas you've voted for
            </h2>
            {voted.length === 0 ? (
              <p className="mt-3 text-ink-2">
                None yet.{" "}
                <Link to="/" className="link">
                  Find something on the board
                </Link>
                .
              </p>
            ) : (
              <ol className="card mt-4 divide-y divide-line">
                {voted.map((v) => (
                  <li key={v.id} className="flex items-center justify-between gap-3 px-4 py-3.5 sm:px-5">
                    <div className="min-w-0">
                      <Link to={`/ideas/${v.id}`} className="font-semibold hover:underline">
                        {v.title}
                      </Link>
                      <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-ink-3">
                        <span>voted {ago(v.votedAt, now)}</span>
                        <span>· {plural(v.voteCount, "vote")}</span>
                        {v.status !== "open" && <StatusChip status={v.status} />}
                      </p>
                    </div>
                    {v.status === "open" && <ShareButton ideaId={v.id} title={v.title} isAuthor={false} variant="icon" />}
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>
      </div>
    </>
  );
}
