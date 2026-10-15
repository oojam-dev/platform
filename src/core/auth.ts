/**
 * Sessions, CSRF and GitHub OAuth (SPEC §6.1). The session token lives only in the cookie;
 * the database keeps its SHA-256. CSRF tokens are an HMAC of the session id, so they need
 * no storage and can't be forged without SESSION_SECRET.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { and, eq, gt } from "drizzle-orm";

import type { Database, DbOrTx } from "../db/client.js";
import { sessions, users } from "../db/schema.js";
import { config } from "./config.js";

export const SESSION_COOKIE = "oojam_session";
export const STATE_COOKIE = "oojam_oauth_state";
export const SESSION_DAYS = 30;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const hmac = (s: string) => createHmac("sha256", config.sessionSecret).update(s).digest("base64url");

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export async function createSession(db: DbOrTx, userId: number): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  await db.insert(sessions).values({ id: sha256(token), userId, expiresAt });
  return { token, expiresAt };
}

export type SessionUser = typeof users.$inferSelect & { sessionId: string };

export async function userForSession(db: DbOrTx, token: string | undefined): Promise<SessionUser | undefined> {
  if (!token || token.length > 100) return undefined;
  const id = sha256(token);
  const [row] = await db
    .select({ user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, id), gt(sessions.expiresAt, new Date())));
  return row ? { ...row.user, sessionId: id } : undefined;
}

export async function destroySession(db: DbOrTx, token: string | undefined): Promise<void> {
  if (token) await db.delete(sessions).where(eq(sessions.id, sha256(token)));
}

export function csrfTokenFor(sessionId: string): string {
  return hmac(`csrf:${sessionId}`);
}

export function verifyCsrf(sessionId: string, token: unknown): boolean {
  return typeof token === "string" && safeEqual(token, csrfTokenFor(sessionId));
}

/** OAuth state: random nonce + HMAC, kept in a short-lived cookie and echoed by GitHub. */
export function newOAuthState(returnTo = "/"): { state: string; cookie: string } {
  const nonce = randomBytes(16).toString("base64url");
  const safeReturn = returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo : "/";
  const cookie = `${nonce}.${Buffer.from(safeReturn).toString("base64url")}.${hmac(`state:${nonce}:${safeReturn}`)}`;
  return { state: nonce, cookie };
}

export function checkOAuthState(cookie: string | undefined, state: string | null): { ok: boolean; returnTo: string } {
  if (!cookie || !state) return { ok: false, returnTo: "/" };
  const [nonce, ret, mac] = cookie.split(".");
  if (!nonce || !ret || !mac) return { ok: false, returnTo: "/" };
  const returnTo = Buffer.from(ret, "base64url").toString();
  const ok = safeEqual(nonce, state) && safeEqual(mac, hmac(`state:${nonce}:${returnTo}`));
  return { ok, returnTo: ok ? returnTo : "/" };
}

export function githubAuthorizeUrl(state: string): string {
  const u = new URL("https://github.com/login/oauth/authorize");
  u.searchParams.set("client_id", config.githubOAuthClientId);
  u.searchParams.set("redirect_uri", `${config.platformUrl}/auth/github/callback`);
  u.searchParams.set("scope", "read:user");
  u.searchParams.set("state", state);
  u.searchParams.set("allow_signup", "true");
  return u.toString();
}

export interface GithubUser {
  id: number;
  login: string;
  name: string | null;
  avatar_url: string | null;
  created_at: string;
}

export async function githubUserFromCode(code: string): Promise<GithubUser> {
  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: config.githubOAuthClientId,
      client_secret: config.githubOAuthClientSecret,
      code,
      redirect_uri: `${config.platformUrl}/auth/github/callback`,
    }),
  });
  const tokenJson = (await tokenRes.json()) as { access_token?: string; error?: string };
  if (!tokenJson.access_token) throw new Error(`GitHub token exchange failed: ${tokenJson.error ?? tokenRes.status}`);
  const userRes = await fetch("https://api.github.com/user", {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${tokenJson.access_token}`,
      "User-Agent": "oojam-platform",
    },
  });
  if (!userRes.ok) throw new Error(`GitHub user lookup failed: ${userRes.status}`);
  // We only needed the token for this one call. Revoking it is best-effort.
  return (await userRes.json()) as GithubUser;
}

export class SignInError extends Error {}

/** Creates or refreshes the user for a GitHub identity, enforcing the account-age rule. */
export async function upsertGithubUser(db: Database, gh: GithubUser) {
  const createdAt = new Date(gh.created_at);
  const ageDays = (Date.now() - createdAt.getTime()) / 86_400_000;
  const [existing] = await db.select().from(users).where(eq(users.githubId, gh.id));
  if (!existing && ageDays < config.minGithubAccountAgeDays) {
    throw new SignInError(
      `To keep oojam fair, GitHub accounts must be at least ${config.minGithubAccountAgeDays} days old to join.`,
    );
  }
  if (existing?.bannedAt) throw new SignInError(`This account is suspended: ${existing.bannedReason ?? "see /transparency"}.`);
  const isAdmin = config.adminGithubLogins.includes(gh.login.toLowerCase());
  const values = {
    githubLogin: gh.login,
    name: gh.name,
    avatarUrl: gh.avatar_url,
    githubCreatedAt: createdAt,
    ...(isAdmin ? { isAdmin: true } : {}),
  };
  if (existing) {
    const [u] = await db.update(users).set(values).where(eq(users.id, existing.id)).returning();
    return u!;
  }
  const [u] = await db.insert(users).values({ githubId: gh.id, ...values }).returning();
  return u!;
}
