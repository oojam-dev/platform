/**
 * GET /connect?return=/photos: "Sign in with oojam" for oojam.dev. Signs you in with GitHub
 * here if needed, then sends you back to the site with a signed identity token (SPEC §6.7).
 */
import { redirect } from "react-router";

import { config } from "../../src/core/config.js";
import { issueViewerToken, safeReturnPath } from "../../src/core/identity.js";
import { requireUser } from "../lib/session.server";
import type { Route } from "./+types/connect";

export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireUser(request);
  const returnTo = safeReturnPath(new URL(request.url).searchParams.get("return"));
  if (user.bannedAt) {
    throw new Response("This account is suspended, so it can't sign in to oojam.dev.", { status: 403 });
  }
  const site = config.siteUrl.replace(/\/$/, "");
  const callback = new URL(`${site}/_oojam/callback`);
  callback.searchParams.set("token", issueViewerToken(user));
  callback.searchParams.set("return", returnTo);
  return redirect(callback.toString(), { headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
}
