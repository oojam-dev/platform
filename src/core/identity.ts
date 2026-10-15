/**
 * "Sign in with oojam" for oojam.dev (SPEC §6.7). The site has no accounts and no secrets, so
 * build.oojam.dev vouches for who someone is: it signs a short token with an Ed25519 private
 * key only the platform holds, and the site verifies it with the public key committed in its
 * repo (app/lib/oojam-identity.server.ts, a protected file builds can't change).
 *
 * Token: base64url(JSON payload) "." base64url(Ed25519 signature over the first part).
 */
import { createPrivateKey, createPublicKey, sign, type KeyObject } from "node:crypto";

export interface ViewerClaims {
  v: 1;
  aud: "oojam.dev";
  /** GitHub user id (stable) and login (display). */
  sub: number;
  login: string;
  iat: number;
  exp: number;
}

export const VIEWER_TOKEN_DAYS = 7;

let key: KeyObject | undefined;
function privateKey(): KeyObject {
  if (!key) {
    const b64 = process.env.OOJAM_IDENTITY_PRIVATE_KEY;
    if (!b64) throw new Error("OOJAM_IDENTITY_PRIVATE_KEY is not set");
    key = createPrivateKey(Buffer.from(b64, "base64").toString("utf8"));
    if (key.asymmetricKeyType !== "ed25519") throw new Error("OOJAM_IDENTITY_PRIVATE_KEY must be an Ed25519 key");
  }
  return key;
}

/** The public half, as PEM, for the site repo. */
export function identityPublicKeyPem(): string {
  return createPublicKey(privateKey()).export({ type: "spki", format: "pem" }).toString();
}

export function issueViewerToken(user: { githubId: number; githubLogin: string }, now = new Date()): string {
  const iat = Math.floor(now.getTime() / 1000);
  const claims: ViewerClaims = { v: 1, aud: "oojam.dev", sub: user.githubId, login: user.githubLogin, iat, exp: iat + VIEWER_TOKEN_DAYS * 86_400 };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = sign(null, Buffer.from(payload), privateKey()).toString("base64url");
  return `${payload}.${signature}`;
}

/** Only same-site paths may be returned to (no //host, no schemes). */
export function safeReturnPath(raw: string | null | undefined): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\") || /[\u0000-\u001f]/.test(raw)) return "/";
  return raw.slice(0, 512);
}
