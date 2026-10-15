/** GET /auth/github/callback — finish the OAuth flow and start a session. */
import { Link, data, redirect } from "react-router";

import {
  STATE_COOKIE,
  SignInError,
  checkOAuthState,
  createSession,
  githubUserFromCode,
  upsertGithubUser,
} from "../../src/core/auth.js";
import { setReferrer } from "../../src/core/referrals.js";
import { getDb } from "../../src/db/client.js";
import { githubUserExists } from "../lib/queries.server";
import { refFromCookie } from "../lib/referral.server";
import { clearStateCookie, getCookie, sessionCookie } from "../lib/session.server";
import type { Route } from "./+types/auth.github.callback";

export const meta: Route.MetaFunction = () => [{ title: "Signing in · oojam build" }];

type Problem = { kind: "denied" | "state" | "too_new" | "banned" | "github"; message: string; reason?: string | null };

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const headers = new Headers({ "Set-Cookie": clearStateCookie() });
  const problem = (p: Problem, status = 400) => data({ problem: p }, { status, headers });

  if (url.searchParams.get("error")) {
    return problem({ kind: "denied", message: "GitHub sign-in was cancelled. No problem — nothing was shared." });
  }
  const { ok, returnTo } = checkOAuthState(getCookie(request, STATE_COOKIE), url.searchParams.get("state"));
  const code = url.searchParams.get("code");
  if (!ok || !code) {
    return problem({
      kind: "state",
      message: "That sign-in link expired or was opened in a different browser. Please start again.",
    });
  }

  const db = getDb();
  let user;
  try {
    const gh = await githubUserFromCode(code);
    const existed = await githubUserExists(db, gh.id);
    user = await upsertGithubUser(db, gh);
    // A brand-new account that arrived through someone's share link: credit the sharer.
    const ref = refFromCookie(request);
    if (!existed && ref) {
      await setReferrer(db, user.id, ref).catch((error: unknown) => console.error("auth: setReferrer failed:", error));
    }
  } catch (error) {
    if (error instanceof SignInError) return problem({ kind: "too_new", message: error.message }, 403);
    console.error("auth: GitHub sign-in failed:", error);
    return problem({ kind: "github", message: "We couldn't talk to GitHub just now. Please try again in a minute." }, 502);
  }

  if (user.bannedAt) {
    return problem(
      {
        kind: "banned",
        message: "This account is suspended, so it can't sign in.",
        reason: user.bannedReason,
      },
      403,
    );
  }

  const { token } = await createSession(db, user.id);
  headers.append("Set-Cookie", sessionCookie(token));
  return redirect(returnTo, { headers });
}

const TITLES: Record<Problem["kind"], string> = {
  denied: "Sign-in cancelled",
  state: "Let's try that again",
  too_new: "Your GitHub account is a bit too new",
  banned: "Account suspended",
  github: "GitHub didn't answer",
};

export default function Callback({ loaderData }: Route.ComponentProps) {
  const { problem } = loaderData;
  return (
    <section className="max-w-xl py-6">
      <p className="kicker mb-2">Sign in with GitHub</p>
      <h1 className="font-display text-3xl font-black tracking-tight sm:text-4xl">{TITLES[problem.kind]}</h1>
      <p className="mt-4 text-lg leading-relaxed text-ink-2">{problem.message}</p>
      {problem.kind === "banned" && (
        <p className="mt-3 leading-relaxed text-ink-2">
          {problem.reason ? <>Reason: “{problem.reason}”. </> : null}
          Suspensions and their reasons are listed on{" "}
          <Link to="/transparency" className="link">
            /transparency
          </Link>
          . If you think this is a mistake, open an issue on{" "}
          <a href="https://github.com/oojam-dev/platform/issues" className="link">
            oojam-dev/platform
          </a>
          .
        </p>
      )}
      {problem.kind === "too_new" && (
        <p className="mt-3 leading-relaxed text-ink-2">
          It stops people from creating throwaway accounts to get around the vote limit. You're welcome to browse in the
          meantime.
        </p>
      )}
      <div className="mt-8 flex flex-wrap gap-3">
        {(problem.kind === "state" || problem.kind === "github" || problem.kind === "denied") && (
          <a href="/auth/github" className="btn btn-jam">
            Try again
          </a>
        )}
        <Link to="/" className="btn btn-ghost">
          Back to the board
        </Link>
      </div>
    </section>
  );
}
