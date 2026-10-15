/** GET /auth/github — start the GitHub OAuth web flow. */
import { redirect } from "react-router";

import { githubAuthorizeUrl, newOAuthState } from "../../src/core/auth.js";
import { optionalUser, safeReturn, stateCookie } from "../lib/session.server";
import type { Route } from "./+types/auth.github";

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const returnTo = safeReturn(url.searchParams.get("return"));
  // Already signed in: nothing to do.
  if (await optionalUser(request)) return redirect(returnTo);
  const { state, cookie } = newOAuthState(returnTo);
  return redirect(githubAuthorizeUrl(state), { headers: { "Set-Cookie": stateCookie(cookie) } });
}
