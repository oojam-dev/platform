/**
 * POST /ideas/:id/vote {intent: vote|unvote} — one vote per person per idea, which they can take
 * back while the idea is open. With JavaScript the VoteButton submits via a fetcher (js=1) and
 * gets JSON back; without it, the browser is redirected back with ?vote=<result>.
 */
import { data, redirect } from "react-router";

import { RuleError } from "../../src/core/errors.js";
import { userIdByLogin } from "../../src/core/referrals.js";
import { unvote, vote } from "../../src/core/votes.js";
import { getDb } from "../../src/db/client.js";
import { refFromCookie } from "../lib/referral.server";
import { requireMutation, safeReturn } from "../lib/session.server";
import type { Route } from "./+types/ideas.$id.vote";

export async function loader({ params }: Route.LoaderArgs) {
  return redirect(`/ideas/${encodeURIComponent(params.id)}`);
}

function withParam(path: string, key: string, value: string): string {
  const u = new URL(path, "http://x");
  u.searchParams.set(key, value);
  return u.pathname + u.search + u.hash;
}

export async function action({ request, params }: Route.ActionArgs) {
  const { user, form } = await requireMutation(request);
  const js = form.get("js") === "1";
  const back = safeReturn(form.get("return"), `/ideas/${params.id}`);
  const ideaId = Number(params.id);
  const db = getDb();
  try {
    if (!Number.isSafeInteger(ideaId) || ideaId <= 0) throw new RuleError("not_found", "No such idea.");
    let result;
    if (form.get("intent") === "unvote") {
      result = await unvote(db, user.id, ideaId);
    } else {
      // Credit whoever's share link brought this browser here (core ignores self-referrals).
      const referrerId = await userIdByLogin(db, refFromCookie(request));
      result = await vote(db, user.id, ideaId, referrerId);
    }
    if (js) return data({ ok: true as const, ...result });
    return redirect(withParam(back, "vote", result.voted ? "ok" : "removed"));
  } catch (error) {
    if (!(error instanceof RuleError)) throw error;
    if (js) return data({ ok: false as const, error: error.message }, { status: 400 });
    return redirect(withParam(back, "vote", error.code));
  }
}
