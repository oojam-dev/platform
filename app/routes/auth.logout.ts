/** POST /auth/logout — end the session (CSRF-checked so other sites can't sign you out). */
import { redirect } from "react-router";

import { destroySession } from "../../src/core/auth.js";
import { getDb } from "../../src/db/client.js";
import { assertCsrf, clearSessionCookie, optionalUser, readForm, sessionToken } from "../lib/session.server";
import type { Route } from "./+types/auth.logout";

export async function loader() {
  return redirect("/");
}

export async function action({ request }: Route.ActionArgs) {
  const user = await optionalUser(request);
  const form = await readForm(request);
  if (user) {
    assertCsrf(user, form);
    await destroySession(getDb(), sessionToken(request));
  }
  return redirect("/", { headers: { "Set-Cookie": clearSessionCookie() } });
}
