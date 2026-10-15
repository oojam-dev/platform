/**
 * GET /embed/ideas/:id — a compact card other sites can iframe (used by /oembed). It's the
 * only frameable page: it sends `Content-Security-Policy: frame-ancestors *` and never
 * X-Frame-Options. Inside a third-party iframe our Lax cookies aren't sent, so it always
 * renders signed-out; voting happens on the real page (target=_top).
 */
import { data } from "react-router";

import { config } from "../../src/core/config.js";
import { getIdea } from "../../src/core/ideas.js";
import { listVoters } from "../../src/core/votes.js";
import { getDb } from "../../src/db/client.js";
import { Avatar, StatusChip, Wordmark } from "../components/ui";
import type { Route } from "./+types/embed.ideas.$id";

const EMBED_HEADERS = {
  "Content-Security-Policy": "frame-ancestors *",
  "Cache-Control": "public, max-age=60",
};

export function headers(): HeadersInit {
  return EMBED_HEADERS;
}

export const meta: Route.MetaFunction = ({ data }) => [
  { title: data ? `${data.idea.title} · oojam` : "oojam" },
  { name: "robots", content: "noindex" },
];

export async function loader({ params }: Route.LoaderArgs) {
  const id = Number(params.id);
  const idea = Number.isSafeInteger(id) && id > 0 ? await getIdea(getDb(), id) : undefined;
  if (!idea || idea.hiddenAt) throw data("No such idea.", { status: 404, headers: EMBED_HEADERS });
  const voters = await listVoters(getDb(), idea.id, 8);
  return data(
    {
      idea: {
        id: idea.id,
        title: idea.title,
        author: idea.author,
        voteCount: idea.voteCount,
        status: idea.status,
        screened: Boolean(idea.screenVerdict?.allowed),
      },
      voters: voters.map((v) => ({ login: v.login, avatarUrl: v.avatarUrl })),
      url: `${config.platformUrl}/ideas/${idea.id}`,
    },
    { headers: EMBED_HEADERS },
  );
}

export default function Embed({ loaderData }: Route.ComponentProps) {
  const { idea, voters, url } = loaderData;
  const open = idea.status === "open" && idea.screened;
  return (
    <div className="flex h-dvh max-h-[200px] flex-col justify-between rounded-2xl border border-line bg-card p-4 text-ink">
      <div className="flex items-start justify-between gap-3">
        <a href={url} target="_top" rel="noopener" className="min-w-0">
          <p className="line-clamp-2 font-display text-lg leading-snug font-black tracking-tight hover:underline">
            {idea.title}
          </p>
          <p className="mt-0.5 text-xs text-ink-3">by @{idea.author}</p>
        </a>
        <a href={url} target="_top" rel="noopener" aria-label="oojam" className="shrink-0">
          <Wordmark className="text-xl" />
        </a>
      </div>
      <div className="flex items-end justify-between gap-3">
        <div className="flex items-center gap-3">
          <p className="leading-none">
            <span className="num font-display text-3xl font-black">{idea.voteCount}</span>
            <span className="ml-1 text-xs font-semibold text-ink-3">{idea.voteCount === 1 ? "vote" : "votes"}</span>
          </p>
          {voters.length > 0 && (
            <span className="flex -space-x-2" aria-hidden="true">
              {voters.slice(0, 6).map((v) => (
                <span key={v.login} className="rounded-full ring-2 ring-card">
                  <Avatar src={v.avatarUrl} login={v.login} size={24} />
                </span>
              ))}
            </span>
          )}
        </div>
        {open ? (
          <a href={url} target="_top" rel="noopener" className="btn btn-jam btn-sm">
            Vote on oojam
          </a>
        ) : (
          <StatusChip status={idea.status === "open" ? "screening" : idea.status} />
        )}
      </div>
    </div>
  );
}
