/**
 * Share links carry ?ref=<github login>. A visit records the referral and drops a 30-day
 * cookie, so a later sign-up or vote from this browser can be credited to the sharer.
 * The counting itself lives in src/core/referrals.ts.
 */
import { isbot } from "isbot";

import { recordRefVisit } from "../../src/core/referrals.js";
import { getDb } from "../../src/db/client.js";
import { getCookie, serializeCookie } from "./session.server";

export const REF_COOKIE = "oojam_ref";
const REF_DAYS = 30;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

export function cleanLogin(raw: string | null | undefined): string | null {
  const s = (raw ?? "").trim().replace(/^@/, "");
  return LOGIN.test(s) ? s : null;
}

/** The sharer's login from the ref cookie, if any. */
export function refFromCookie(request: Request): string | null {
  return cleanLogin(getCookie(request, REF_COOKIE));
}

export const refCookie = (login: string) => serializeCookie(REF_COOKIE, login, REF_DAYS * 86_400);

/**
 * For document requests with ?ref=<login>: records the visit (ignoring bots and link
 * unfurlers, which fetch every shared URL) and returns a Set-Cookie value, or null.
 */
export async function captureRef(request: Request): Promise<string | null> {
  if (request.method !== "GET") return null;
  const url = new URL(request.url);
  const login = cleanLogin(url.searchParams.get("ref"));
  if (!login) return null;
  const ua = request.headers.get("user-agent");
  if (!ua || isbot(ua)) return null;
  // Same browser, same sharer: don't count reloads.
  if (refFromCookie(request)?.toLowerCase() === login.toLowerCase()) return null;
  const m = /^\/(?:ideas|embed\/ideas)\/(\d+)$/.exec(url.pathname);
  const ideaId = m ? Number(m[1]) : null;
  try {
    // Unknown logins aren't recorded, and don't get a cookie either.
    const referrerId = await recordRefVisit(getDb(), { ideaId, referrerLogin: login });
    return referrerId ? refCookie(login) : null;
  } catch (error) {
    console.error("ref: failed to record visit:", error);
    return null;
  }
}

/** Canonical form of a URL for previews: no ?ref. */
export function withoutRef(url: string): string {
  const u = new URL(url);
  u.searchParams.delete("ref");
  return u.toString();
}
