/**
 * Request-level auth helpers for the web app. All the real work (session lookup, CSRF
 * HMAC, OAuth state) lives in src/core/auth.ts; this file only deals with cookies,
 * redirects and HTTP status codes.
 */
import { data, redirect } from "react-router";

import {
  SESSION_COOKIE,
  SESSION_DAYS,
  STATE_COOKIE,
  csrfTokenFor,
  userForSession,
  verifyCsrf,
  type SessionUser,
} from "../../src/core/auth.js";
import { config } from "../../src/core/config.js";
import { getDb } from "../../src/db/client.js";

export type { SessionUser };

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const name = part.slice(0, i).trim();
    let value = part.slice(i + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    try {
      value = decodeURIComponent(value);
    } catch {
      /* keep raw */
    }
    if (name && !(name in out)) out[name] = value;
  }
  return out;
}

export function getCookie(request: Request, name: string): string | undefined {
  return parseCookies(request.headers.get("Cookie"))[name];
}

const secure = () => config.platformUrl.startsWith("https://");

export function serializeCookie(name: string, value: string, maxAgeSeconds: number): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
  ];
  if (maxAgeSeconds <= 0) parts.push("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
  if (secure()) parts.push("Secure");
  return parts.join("; ");
}

export const sessionCookie = (token: string) => serializeCookie(SESSION_COOKIE, token, SESSION_DAYS * 86_400);
export const clearSessionCookie = () => serializeCookie(SESSION_COOKIE, "", 0);
export const stateCookie = (value: string) => serializeCookie(STATE_COOKIE, value, 10 * 60);
export const clearStateCookie = () => serializeCookie(STATE_COOKIE, "", 0);

export function sessionToken(request: Request): string | undefined {
  return getCookie(request, SESSION_COOKIE);
}

export async function optionalUser(request: Request): Promise<SessionUser | undefined> {
  return userForSession(getDb(), sessionToken(request));
}

/** The path (and query) of the current request, for ?return= after sign-in. */
export function currentPath(request: Request): string {
  const u = new URL(request.url);
  return u.pathname + u.search;
}

export function signInUrl(returnTo: string): string {
  return `/auth/github?return=${encodeURIComponent(returnTo)}`;
}

export async function requireUser(request: Request): Promise<SessionUser> {
  const user = await optionalUser(request);
  if (!user) throw redirect(signInUrl(currentPath(request)));
  return user;
}

export async function requireAdmin(request: Request): Promise<SessionUser> {
  const user = await requireUser(request);
  if (!user.isAdmin) throw data("Admins only.", { status: 403, statusText: "Forbidden" });
  return user;
}

export function csrfToken(user: SessionUser | undefined): string | null {
  return user ? csrfTokenFor(user.sessionId) : null;
}

/** Throws a 403 unless the form carries this session's CSRF token. */
export function assertCsrf(user: SessionUser, form: FormData): void {
  if (!verifyCsrf(user.sessionId, form.get("csrf"))) {
    throw data("This form expired or didn't come from oojam. Reload the page and try again.", {
      status: 403,
      statusText: "Forbidden",
    });
  }
}

/**
 * The usual start of a mutating action: signed-in user, parsed form, valid CSRF token.
 * Unauthenticated posts get a 403 rather than a redirect, since there's no form to return to.
 */
export async function requireMutation(request: Request): Promise<{ user: SessionUser; form: FormData }> {
  const user = await optionalUser(request);
  const form = await readForm(request);
  if (!user) throw data("Sign in first.", { status: 403, statusText: "Forbidden" });
  assertCsrf(user, form);
  return { user, form };
}

/** The request's form body, or an empty form if it has none or isn't a form (so CSRF fails with 403, not 500). */
export async function readForm(request: Request): Promise<FormData> {
  try {
    return await request.formData();
  } catch {
    return new FormData();
  }
}

/** A same-site path to send people back to, never an open redirect. */
export function safeReturn(raw: unknown, fallback = "/"): string {
  if (typeof raw !== "string") return fallback;
  return raw.startsWith("/") && !raw.startsWith("//") && !raw.startsWith("/\\") ? raw : fallback;
}
