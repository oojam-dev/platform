import { useState } from "react";
import { Form, Link, data, redirect, useNavigation } from "react-router";

import { screenAndApply } from "../../src/core/ideas.js";
import { config } from "../../src/core/config.js";
import { RuleError } from "../../src/core/errors.js";
import { BODY_MAX, TITLE_MAX, TITLE_MIN, postIdea, postsToday } from "../../src/core/votes.js";
import { getDb } from "../../src/db/client.js";
import { BackLink, CsrfInput, Notice, PageTitle } from "../components/ui";
import { requireMutation, requireUser } from "../lib/session.server";
import type { Route } from "./+types/ideas.new";

export const meta: Route.MetaFunction = () => [{ title: "Post an idea · oojam build" }];

export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireUser(request);
  const db = getDb();
  const today = await postsToday(db, user.id);
  return {
    postedToday: today.posts,
    attemptsToday: today.attempts,
    maxIdeas: config.maxIdeasPerDay,
    maxAttempts: config.maxPostAttemptsPerDay,
    banned: Boolean(user.bannedAt),
  };
}

export async function action({ request }: Route.ActionArgs) {
  const { user, form } = await requireMutation(request);
  const title = String(form.get("title") ?? "");
  const body = String(form.get("body") ?? "");
  const db = getDb();
  let ideaId: number;
  try {
    const idea = await postIdea(db, user.id, { title, body });
    ideaId = idea.id;
  } catch (error) {
    if (error instanceof RuleError) return data({ error: error.message, title, body }, { status: 400 });
    throw error;
  }
  // Screening takes a few seconds. If it fails (API down), the idea stays "Screening…" and
  // the worker retries; either way the idea page explains what happened.
  await screenAndApply(db, ideaId);
  return redirect(`/ideas/${ideaId}?posted=1`);
}

function Counter({ n, min, max }: { n: number; min?: number; max: number }) {
  const bad = n > max || (min !== undefined && n > 0 && n < min);
  return (
    <span className={`num text-xs ${bad ? "font-bold text-warn" : "text-ink-3"}`} aria-hidden="true">
      {n.toLocaleString("en-US")}/{max.toLocaleString("en-US")}
    </span>
  );
}

export default function NewIdea({ loaderData, actionData }: Route.ComponentProps) {
  const { postedToday, attemptsToday, maxIdeas, maxAttempts, banned } = loaderData;
  const [title, setTitle] = useState(actionData?.title ?? "");
  const [body, setBody] = useState(actionData?.body ?? "");
  const nav = useNavigation();
  const submitting = nav.state === "submitting" && nav.formMethod === "POST";
  const limitReached = postedToday >= maxIdeas || attemptsToday >= maxAttempts;
  const blocked = banned || limitReached;
  const titleLen = title.replace(/\s+/g, " ").trim().length;

  return (
    <div className="mx-auto max-w-2xl">
      <BackLink to="/">The board</BackLink>
      <PageTitle kicker="Post an idea · free" title="What should oojam.dev become next?">
        Describe one thing that could be built in a day. If it reaches the top of the board at 00:00&nbsp;UTC, Claude
        builds it and it goes live. It's free: you can post {maxIdeas === 1 ? "one idea" : `${maxIdeas} ideas`} a day,
        and posting counts as your vote for it.
      </PageTitle>

      {banned ? (
        <Notice tone="warn" title="Your account is suspended.">
          Suspended accounts can't post ideas.
        </Notice>
      ) : limitReached ? (
        <Notice tone="jam" title="You've posted today's idea." className="mb-8">
          {attemptsToday >= maxAttempts && postedToday < maxIdeas
            ? "That's enough attempts for today, too. "
            : ""}
          You can post again after 00:00 UTC. Meanwhile,{" "}
          <Link to="/" className="font-bold underline">
            vote on the board
          </Link>
          .
        </Notice>
      ) : null}

      {actionData?.error && (
        <Notice tone="warn" className="mb-6">
          {actionData.error}
        </Notice>
      )}

      <Form method="post" className="card space-y-6 p-5 sm:p-7" aria-busy={submitting}>
        <CsrfInput />
        <div>
          <div className="flex items-baseline justify-between">
            <label htmlFor="title" className="label">
              Title
            </label>
            <Counter n={titleLen} min={TITLE_MIN} max={TITLE_MAX} />
          </div>
          <input
            id="title"
            name="title"
            className="field text-lg font-semibold"
            required
            minLength={TITLE_MIN}
            maxLength={TITLE_MAX}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="A wall of tiny drawings anyone can add to"
            aria-describedby="title-help"
            autoComplete="off"
          />
          <p id="title-help" className="mt-1.5 text-xs text-ink-3">
            {TITLE_MIN}–{TITLE_MAX} characters. Say what it is, not why it's great.
          </p>
        </div>

        <div>
          <div className="flex items-baseline justify-between">
            <label htmlFor="body" className="label">
              Description <span className="font-normal text-ink-3">(optional, Markdown)</span>
            </label>
            <Counter n={body.trim().length} max={BODY_MAX} />
          </div>
          <textarea
            id="body"
            name="body"
            rows={9}
            maxLength={BODY_MAX}
            className="field font-mono text-sm leading-relaxed"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={"What should a visitor see and be able to do?\n\n- Keep it to one feature\n- Mention anything it must not do"}
            aria-describedby="body-help"
          />
          <p id="body-help" className="mt-1.5 text-xs text-ink-3">
            Up to {BODY_MAX.toLocaleString("en-US")} characters. Links and formatting work; raw HTML doesn't.
          </p>
        </div>

        <div className="rounded-2xl bg-sunk p-4 text-sm leading-relaxed text-ink-2">
          <p>
            <strong className="text-ink">Screened before it's listed.</strong> Claude checks every idea against the{" "}
            <Link to="/rules" className="link">
              content policy
            </Link>
            . If it's out of policy, it's rejected with a reason, and a rejection doesn't count as
            today's idea (you get {maxAttempts} tries a day).
          </p>
        </div>

        <div className="flex flex-col-reverse items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-ink-3">
            Ideas left today: <span className="num font-semibold text-ink">{Math.max(0, maxIdeas - postedToday)}</span>
          </p>
          <button type="submit" className="btn btn-jam px-6 py-3 text-base" disabled={blocked || submitting}>
            {submitting ? "Posting & screening…" : "Post idea"}
          </button>
        </div>
      </Form>
    </div>
  );
}
