/**
 * POST /ideas/:id/vote — one credit, one vote. With JavaScript the VoteButton submits via a
 * fetcher (js=1) and gets JSON back; without it, the browser is redirected back to where it
 * came from with ?vote=<result>.
 */
import { data, redirect } from "react-router";

import { LedgerError, vote } from "../../src/core/ledger.js";
import { getDb } from "../../src/db/client.js";
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
  try {
    if (!Number.isSafeInteger(ideaId) || ideaId <= 0) throw new LedgerError("not_found", "No such idea.");
    const result = await vote(getDb(), user.id, ideaId);
    if (js) return data({ ok: true as const, ...result });
    return redirect(withParam(back, "vote", "ok"));
  } catch (error) {
    if (!(error instanceof LedgerError)) throw error;
    if (js) return data({ ok: false as const, error: error.message }, { status: 400 });
    return redirect(withParam(back, "vote", error.code));
  }
}
