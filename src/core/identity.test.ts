import { generateKeyPairSync, verify } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import { identityPublicKeyPem, issueViewerToken, safeReturnPath } from "./identity.js";

describe("viewer tokens", () => {
  beforeAll(() => {
    const { privateKey } = generateKeyPairSync("ed25519");
    process.env.OOJAM_IDENTITY_PRIVATE_KEY = Buffer.from(privateKey.export({ type: "pkcs8", format: "pem" }).toString()).toString("base64");
  });

  it("signs claims the site can verify with the public key", () => {
    const token = issueViewerToken({ githubId: 42, githubLogin: "octocat" }, new Date("2026-10-15T00:00:00Z"));
    const [payload, sig] = token.split(".");
    expect(verify(null, Buffer.from(payload!), identityPublicKeyPem(), Buffer.from(sig!, "base64url"))).toBe(true);
    const claims = JSON.parse(Buffer.from(payload!, "base64url").toString());
    expect(claims).toMatchObject({ v: 1, aud: "oojam.dev", sub: 42, login: "octocat" });
    expect(claims.exp - claims.iat).toBe(7 * 86_400);
    // Tampering breaks the signature.
    const forged = Buffer.from(JSON.stringify({ ...claims, login: "admin" })).toString("base64url");
    expect(verify(null, Buffer.from(forged), identityPublicKeyPem(), Buffer.from(sig!, "base64url"))).toBe(false);
  });

  it("only returns to same-site paths", () => {
    expect(safeReturnPath("/photos?x=1")).toBe("/photos?x=1");
    for (const bad of ["//evil.com", "https://evil.com", "javascript:alert(1)", "/\\evil.com", "", null, "photos"]) {
      expect(safeReturnPath(bad)).toBe("/");
    }
  });
});
