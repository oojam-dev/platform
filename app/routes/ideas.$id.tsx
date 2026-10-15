import { Form, Link, data, useNavigation, useSearchParams } from "react-router";

import { banUser, hideComment, hideIdea, rejectIdea } from "../../src/core/admin.js";
import { COMMENT_MAX, addComment, getIdea } from "../../src/core/ideas.js";
import { LedgerError, hasPaidTopup } from "../../src/core/ledger.js";
import { getDb } from "../../src/db/client.js";
import { Author, BackLink, CsrfInput, Markdown, Notice, StatusChip } from "../components/ui";
import { VoteButton } from "../components/vote-button";
import { VoteNotice } from "../components/vote-notice";
import { ago, dateTime, money, plural } from "../lib/format";
import { renderMarkdown } from "../lib/markdown.server";
import { optionalUser, requireMutation } from "../lib/session.server";
import type { Route } from "./+types/ideas.$id";

export const meta: Route.MetaFunction = ({ data }) => [
  { title: data ? `${data.idea.title} · oojam build` : "Idea · oojam build" },
];

function parseId(raw: string): number {
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) throw data("No such idea.", { status: 404 });
  return id;
}

export async function loader({ request, params }: Route.LoaderArgs) {
  const id = parseId(params.id);
  const db = getDb();
  const user = await optionalUser(request);
  const idea = await getIdea(db, id, user?.id);
  if (!idea) throw data("No such idea.", { status: 404 });
  const isAdmin = Boolean(user?.isAdmin);
  const hidden = Boolean(idea.hiddenAt);
  const canComment = user ? await hasPaidTopup(db, user.id) : false;
  return {
    idea: {
      id: idea.id,
      title: idea.title,
      status: idea.status,
      voteCount: idea.voteCount,
      voters: idea.voters,
      myVotes: idea.myVotes,
      author: idea.author,
      authorId: idea.authorId,
      authorAvatar: idea.authorAvatar,
      createdAt: idea.createdAt,
      frozenAt: idea.frozenAt,
      decidedAt: idea.decidedAt,
      hiddenAt: idea.hiddenAt,
      rejectedReason: idea.rejectedReason,
      screen: idea.screenVerdict ? { allowed: idea.screenVerdict.allowed, reason: idea.screenVerdict.reason } : null,
      // Hidden ideas keep their title for the record but not their body (admins still see it).
      bodyHtml: hidden && !isAdmin ? "" : renderMarkdown(idea.body),
      comments: hidden && !isAdmin ? [] : idea.comments,
      build: idea.build
        ? {
            id: idea.build.id,
            day: idea.build.day,
            status: idea.build.status,
            prUrl: idea.build.prUrl,
            error: idea.build.error,
            costCents: idea.build.costCents,
          }
        : null,
    },
    viewer: user ? { id: user.id, isAdmin, canComment } : null,
    now: Date.now(),
  };
}

type ActionResult = { ok: true; intent: string; message?: string } | { ok: false; intent: string; error: string; body?: string };

export async function action({ request, params }: Route.ActionArgs) {
  const ideaId = parseId(params.id);
  const { user, form } = await requireMutation(request);
  const intent = String(form.get("intent") ?? "");
  const reason = String(form.get("reason") ?? "");
  const db = getDb();
  const fail = (error: string, extra: Partial<ActionResult> = {}) =>
    data({ ok: false, intent, error, ...extra } as ActionResult, { status: 400 });

  const adminOnly = () => {
    if (!user.isAdmin) throw data("Admins only.", { status: 403 });
  };

  try {
    switch (intent) {
      case "comment": {
        const body = String(form.get("body") ?? "");
        try {
          await addComment(db, user.id, ideaId, body);
        } catch (error) {
          if (error instanceof LedgerError) return fail(error.message, { body });
          throw error;
        }
        return { ok: true, intent } as ActionResult;
      }
      case "hide_idea":
        adminOnly();
        await hideIdea(db, user.id, ideaId, reason);
        return { ok: true, intent, message: "Idea hidden." } as ActionResult;
      case "reject_idea":
        adminOnly();
        await rejectIdea(db, user.id, ideaId, reason);
        return { ok: true, intent, message: "Idea rejected." } as ActionResult;
      case "hide_comment": {
        adminOnly();
        const commentId = Number(form.get("commentId"));
        if (!Number.isSafeInteger(commentId)) return fail("Which comment?");
        await hideComment(db, user.id, commentId, reason);
        return { ok: true, intent, message: "Comment hidden." } as ActionResult;
      }
      case "ban_author": {
        adminOnly();
        const idea = await getIdea(db, ideaId);
        if (!idea) return fail("No such idea.");
        if (idea.authorId === user.id) return fail("You can't ban yourself.");
        await banUser(db, user.id, idea.authorId, reason);
        return { ok: true, intent, message: `@${idea.author} is banned.` } as ActionResult;
      }
      default:
        return fail("Unknown action.");
    }
  } catch (error) {
    if (error instanceof LedgerError) return fail(error.message);
    throw error;
  }
}

function StatusPanel({ idea }: { idea: Route.ComponentProps["loaderData"]["idea"] }) {
  const screening = idea.status === "open" && !idea.screen;
  if (idea.hiddenAt) {
    return (
      <Notice tone="warn" title="Hidden by a moderator">
        {idea.rejectedReason ? `Reason: ${idea.rejectedReason}` : "This idea was hidden."} Every moderation action is listed on{" "}
        <Link to="/transparency" className="underline">
          /transparency
        </Link>
        .
      </Notice>
    );
  }
  if (screening) {
    return (
      <Notice tone="jam" title="Screening…">
        Claude is checking this idea against the content policy. It joins the board as soon as it passes — usually
        within seconds. If the screener is unavailable, it's retried automatically. If it's rejected, the $1 is refunded.
      </Notice>
    );
  }
  if (idea.status === "rejected") {
    if (idea.screen && !idea.screen.allowed) {
      return (
        <Notice tone="warn" title="Screening didn't pass this idea">
          <p>{idea.screen.reason}</p>
          <p className="mt-1">The $1 was refunded to @{idea.author}'s wallet. Feel free to rework it and post again.</p>
        </Notice>
      );
    }
    return (
      <Notice tone="warn" title="Rejected">
        {idea.rejectedReason ?? "This idea was rejected."} Votes already committed stay committed.
      </Notice>
    );
  }
  if (idea.status === "frozen" || idea.status === "building") {
    return (
      <Notice tone="jam" title={idea.status === "frozen" ? "Frozen — voting is closed" : "Being built right now"}>
        This idea topped the board at 00:00 UTC
        {idea.frozenAt ? ` on ${dateTime(idea.frozenAt).split(",")[0]}` : ""}.{" "}
        {idea.build && (
          <Link to={`/builds/${idea.build.id}`} className="font-bold underline">
            Follow the build →
          </Link>
        )}
      </Notice>
    );
  }
  if (idea.status === "deployed") {
    return (
      <Notice tone="ok" title="Built and live on oojam.dev">
        <span className="flex flex-wrap gap-x-4 gap-y-1">
          <a href="https://oojam.dev" className="font-bold underline">
            Visit oojam.dev →
          </a>
          {idea.build && (
            <Link to={`/builds/${idea.build.id}`} className="underline">
              Build #{idea.build.id} · {money(idea.build.costCents)}
            </Link>
          )}
          {idea.build?.prUrl && (
            <a href={idea.build.prUrl} className="underline" rel="noopener">
              Pull request
            </a>
          )}
        </span>
      </Notice>
    );
  }
  if (idea.status === "failed") {
    return (
      <Notice tone="warn" title="The build failed">
        <p>{idea.build?.error ?? idea.rejectedReason ?? "No reason was recorded."}</p>
        <span className="mt-1 flex flex-wrap gap-x-4">
          {idea.build && (
            <Link to={`/builds/${idea.build.id}`} className="underline">
              Build #{idea.build.id}
            </Link>
          )}
          {idea.build?.prUrl && (
            <a href={idea.build.prUrl} className="underline" rel="noopener">
              Pull request
            </a>
          )}
        </span>
      </Notice>
    );
  }
  return null;
}

function closedReason(idea: Route.ComponentProps["loaderData"]["idea"]): string {
  if (idea.hiddenAt) return "Hidden ideas don't take votes.";
  if (idea.status === "open" && !idea.screen) return "Voting opens as soon as screening passes.";
  if (idea.status === "frozen" || idea.status === "building") return "Voting closed when this idea was frozen.";
  if (idea.status === "deployed") return "Already built — no more votes needed.";
  if (idea.status === "rejected") return "Rejected ideas don't take votes.";
  return "This idea isn't taking votes.";
}

function ReasonForm({ intent, label, extra, danger = false }: { intent: string; label: string; extra?: Record<string, string | number>; danger?: boolean }) {
  const nav = useNavigation();
  const busy = nav.state === "submitting" && nav.formData?.get("intent") === intent;
  const id = `reason-${intent}-${extra ? Object.values(extra).join("-") : ""}`;
  return (
    <Form method="post" className="flex flex-col gap-2 sm:flex-row">
      <CsrfInput />
      <input type="hidden" name="intent" value={intent} />
      {extra && Object.entries(extra).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      <label htmlFor={id} className="sr-only">
        Reason for “{label}” (published)
      </label>
      <input id={id} name="reason" required placeholder="Reason (published on /transparency)" className="field py-1.5 text-sm" />
      <button type="submit" className={`btn btn-sm ${danger ? "btn-jam" : "btn-ghost"}`} disabled={busy}>
        {busy ? "…" : label}
      </button>
    </Form>
  );
}

export default function IdeaPage({ loaderData, actionData }: Route.ComponentProps) {
  const { idea, viewer, now } = loaderData;
  const [params] = useSearchParams();
  const nav = useNavigation();
  const commenting = nav.state === "submitting" && nav.formData?.get("intent") === "comment";
  const votable = idea.status === "open" && Boolean(idea.screen?.allowed) && !idea.hiddenAt;
  const status = idea.hiddenAt ? "hidden" : idea.status === "open" && !idea.screen ? "screening" : idea.status;
  const commentError = actionData && !actionData.ok && actionData.intent === "comment" ? actionData : null;
  const adminResult = actionData && actionData.intent !== "comment" ? actionData : null;
  const visibleComments = idea.comments.filter((c) => !c.hiddenAt).length;

  return (
    <article>
      <BackLink to="/">The board</BackLink>
      <VoteNotice />
      {params.get("posted") === "1" && idea.status !== "rejected" && (
        <Notice tone="ok" className="mb-6" title={idea.screen ? "Posted and on the board." : "Posted."}>
          {idea.screen
            ? "Your $1 is in and it counts as your first vote. Share the link to rally votes before 00:00 UTC."
            : "It'll appear on the board once screening passes."}
        </Notice>
      )}

      <header className="max-w-3xl">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <StatusChip status={status} />
          <span className="text-sm text-ink-3">Idea #{idea.id}</span>
        </div>
        <h1 className="font-display text-3xl font-black leading-[1.08] tracking-tight text-balance sm:text-[2.6rem]">
          {idea.title}
        </h1>
        <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-ink-3">
          <Author login={idea.author} avatar={idea.authorAvatar} size={22} />
          <span>
            posted <time dateTime={new Date(idea.createdAt).toISOString()}>{ago(idea.createdAt, now)}</time>
          </span>
        </div>
      </header>

      <div className="mt-6 grid gap-8 lg:grid-cols-[minmax(0,1fr)_18rem] lg:gap-12">
        <div className="min-w-0">
          <StatusPanel idea={idea} />

          {idea.bodyHtml ? (
            <Markdown html={idea.bodyHtml} className="mt-6 text-[1.0625rem] first:mt-0" />
          ) : (
            !idea.hiddenAt && <p className="mt-6 text-ink-3 italic first:mt-0">No description — the title says it all.</p>
          )}

          {viewer?.isAdmin && (
            <details className="mt-10 rounded-2xl border border-dashed border-line-strong p-4">
              <summary className="cursor-pointer text-sm font-bold">Moderation</summary>
              {adminResult && (
                <Notice tone={adminResult.ok ? "ok" : "warn"} className="mt-3">
                  {adminResult.ok ? adminResult.message : adminResult.error}
                </Notice>
              )}
              <div className="mt-4 space-y-3">
                {!idea.hiddenAt && <ReasonForm intent="hide_idea" label="Hide idea" />}
                {idea.status === "open" && <ReasonForm intent="reject_idea" label="Reject idea" />}
                {viewer.id !== idea.authorId && <ReasonForm intent="ban_author" label={`Ban @${idea.author}`} danger />}
              </div>
            </details>
          )}

          <section id="comments" aria-labelledby="comments-title" className="mt-14">
            <h2 id="comments-title" className="font-display text-xl font-black tracking-tight">
              {plural(visibleComments, "comment")}
            </h2>
            {idea.comments.length > 0 && (
              <ol className="mt-5 space-y-5">
                {idea.comments.map((c) => (
                  <li key={c.id} className="border-l-2 border-line pl-4">
                    <div className="flex flex-wrap items-center gap-x-2 text-[0.8125rem] text-ink-3">
                      <Author login={c.author} avatar={c.authorAvatar} />
                      <span>{ago(c.createdAt, now)}</span>
                    </div>
                    {c.hiddenAt ? (
                      <p className="mt-1.5 text-sm text-ink-3 italic">Hidden by a moderator.</p>
                    ) : (
                      <p className="mt-1.5 leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">{c.body}</p>
                    )}
                    {viewer?.isAdmin && !c.hiddenAt && (
                      <details className="mt-2">
                        <summary className="cursor-pointer text-xs font-semibold text-ink-3">Hide comment</summary>
                        <div className="mt-2">
                          <ReasonForm intent="hide_comment" label="Hide" extra={{ commentId: c.id }} />
                        </div>
                      </details>
                    )}
                  </li>
                ))}
              </ol>
            )}

            <div className="mt-8">
              {!viewer ? (
                <p className="text-sm text-ink-2">
                  <Link to={`/auth/github?return=/ideas/${idea.id}%23comments`} className="link">
                    Sign in
                  </Link>{" "}
                  to join the conversation.
                </p>
              ) : !viewer.canComment ? (
                <p className="rounded-2xl bg-sunk p-4 text-sm text-ink-2">
                  Comments are free, but open to people who've topped up at least once — it keeps the spam out.{" "}
                  <Link to="/wallet" className="link">
                    Top up from $5
                  </Link>
                  .
                </p>
              ) : idea.hiddenAt ? null : (
                <Form method="post" key={idea.comments.length} className="space-y-3">
                  <CsrfInput />
                  <input type="hidden" name="intent" value="comment" />
                  <label htmlFor="comment-body" className="label">
                    Add a comment
                  </label>
                  <textarea
                    id="comment-body"
                    name="body"
                    required
                    rows={3}
                    maxLength={COMMENT_MAX}
                    defaultValue={commentError?.body ?? ""}
                    className="field text-[0.9375rem]"
                    placeholder="Plain text. Be kind; suggest, don't demand."
                    aria-describedby={commentError ? "comment-error" : undefined}
                  />
                  {commentError && (
                    <p id="comment-error" role="alert" className="text-sm font-semibold text-warn">
                      {commentError.error}
                    </p>
                  )}
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-xs text-ink-3">Up to {COMMENT_MAX.toLocaleString("en-US")} characters.</span>
                    <button type="submit" className="btn btn-ghost btn-sm" disabled={commenting}>
                      {commenting ? "Posting…" : "Comment"}
                    </button>
                  </div>
                </Form>
              )}
            </div>
          </section>
        </div>

        <aside className="order-first lg:order-none">
          <div className="card p-6 lg:sticky lg:top-6">
            <VoteButton
              variant="large"
              state={{
                ideaId: idea.id,
                title: idea.title,
                voteCount: idea.voteCount,
                mine: idea.myVotes,
                open: votable,
                closedReason: closedReason(idea),
              }}
            />
            <dl className="mt-6 grid grid-cols-2 gap-3 border-t border-line pt-5 text-center">
              <div>
                <dt className="text-xs font-semibold text-ink-3">Backers</dt>
                <dd className="num mt-0.5 font-display text-xl font-black">{idea.voters}</dd>
              </div>
              <div>
                <dt className="text-xs font-semibold text-ink-3">Committed</dt>
                <dd className="num mt-0.5 font-display text-xl font-black">
                  {money(idea.screen && !idea.screen.allowed ? 0 : idea.voteCount * 100)}
                </dd>
              </div>
            </dl>
          </div>
        </aside>
      </div>
    </article>
  );
}
