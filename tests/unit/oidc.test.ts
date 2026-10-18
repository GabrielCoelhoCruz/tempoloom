// Failure modes of ID token verification for single sign-on
// (docs/specs/admin-sso-provisioning.md, sign-in rules). An ID token is the
// only proof of who signed in, so each of these would let a forged identity in:
// 1. A token signed by another key, or a payload changed after signing.
// 2. A token from another issuer (another identity provider).
// 3. A token for another client: the audience does not hold our client id, or
//    several audiences without our client id as the authorized party.
// 4. A token replayed from another sign-in: missing or different nonce.
// 5. An expired token; a token issued in the future.
// 6. Algorithm confusion: "none", or HS256 with the public key as a secret.
// 7. A key id that the identity provider does not publish.
// 8. A malformed token.
// 9. A token without subject or email; an email the provider did not verify
//    is reported as unverified, not trusted silently.
import { createHmac, generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { OidcError, verifyIdToken } from "../../src/server/sso/oidc.ts";

const NOW = Date.UTC(2026, 9, 19, 12, 0, 0);
const ISSUER = "https://idp.example.test";
const CLIENT = "tempoloom";
const NONCE = "n-0123456789";

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");

function keyPair(kind: "rsa" | "ec", kid: string) {
  const { privateKey, publicKey } =
    kind === "rsa"
      ? generateKeyPairSync("rsa", { modulusLength: 2048 })
      : generateKeyPairSync("ec", { namedCurve: "P-256" });
  return { privateKey, jwk: { ...publicKey.export({ format: "jwk" }), kid } };
}

const rsa = keyPair("rsa", "k1");
const other = keyPair("rsa", "k1");
const ec = keyPair("ec", "e1");

function claims(over: Record<string, unknown> = {}) {
  return {
    iss: ISSUER,
    aud: CLIENT,
    sub: "user-1",
    email: "u@corp.test",
    email_verified: true,
    name: "U",
    nonce: NONCE,
    iat: NOW / 1000 - 10,
    exp: NOW / 1000 + 600,
    ...over,
  };
}

function token(
  payload: Record<string, unknown>,
  opts: { key?: KeyObject; alg?: string; kid?: string } = {},
): string {
  const alg = opts.alg ?? "RS256";
  const head = b64({ alg, typ: "JWT", kid: opts.kid ?? "k1" });
  const body = b64(payload);
  const input = Buffer.from(`${head}.${body}`);
  const sig =
    alg === "ES256"
      ? sign("sha256", input, { key: opts.key ?? ec.privateKey, dsaEncoding: "ieee-p1363" })
      : sign("sha256", input, opts.key ?? rsa.privateKey);
  return `${head}.${body}.${sig.toString("base64url")}`;
}

const check = (t: string, over: Partial<Parameters<typeof verifyIdToken>[1]> = {}) =>
  verifyIdToken(t, {
    issuer: ISSUER,
    clientId: CLIENT,
    nonce: NONCE,
    now: NOW,
    keys: [rsa.jwk, ec.jwk],
    ...over,
  });

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    return err instanceof OidcError ? err.code : `not an OidcError: ${String(err)}`;
  }
  return "accepted";
};

describe("verifyIdToken", () => {
  it("accepts a valid RS256 token and returns the identity", () => {
    expect(check(token(claims()))).toEqual({
      sub: "user-1",
      email: "u@corp.test",
      emailVerified: true,
      name: "U",
    });
  });

  it("accepts a valid ES256 token", () => {
    expect(check(token(claims(), { alg: "ES256", kid: "e1" })).sub).toBe("user-1");
  });

  it("rejects a token signed by another key with the same key id", () => {
    expect(code(() => check(token(claims(), { key: other.privateKey })))).toBe("bad_signature");
  });

  it("rejects a payload changed after signing", () => {
    const [h, , s] = token(claims()).split(".");
    const forged = `${h}.${b64(claims({ email: "ceo@corp.test" }))}.${s}`;
    expect(code(() => check(forged))).toBe("bad_signature");
  });

  it("rejects another issuer", () => {
    expect(code(() => check(token(claims({ iss: "https://evil.test" }))))).toBe("bad_issuer");
  });

  it("rejects another audience", () => {
    expect(code(() => check(token(claims({ aud: "someone-else" }))))).toBe("bad_audience");
  });

  it("accepts several audiences only when our client is the authorized party", () => {
    expect(code(() => check(token(claims({ aud: [CLIENT, "api"] }))))).toBe("bad_audience");
    expect(code(() => check(token(claims({ aud: [CLIENT, "api"], azp: "api" }))))).toBe(
      "bad_audience",
    );
    expect(check(token(claims({ aud: [CLIENT, "api"], azp: CLIENT }))).sub).toBe("user-1");
  });

  it("rejects a missing or different nonce", () => {
    expect(code(() => check(token(claims({ nonce: undefined }))))).toBe("bad_nonce");
    expect(code(() => check(token(claims({ nonce: "other" }))))).toBe("bad_nonce");
  });

  it("rejects an expired token and one issued in the future, with one minute of clock skew", () => {
    expect(code(() => check(token(claims({ exp: NOW / 1000 - 120 }))))).toBe("expired");
    expect(check(token(claims({ exp: NOW / 1000 - 30 }))).sub).toBe("user-1");
    expect(code(() => check(token(claims({ iat: NOW / 1000 + 600 }))))).toBe("issued_in_future");
  });

  it("rejects alg none and HS256 signed with the public key", () => {
    const none = `${b64({ alg: "none", kid: "k1" })}.${b64(claims())}.`;
    expect(code(() => check(none))).toBe("bad_algorithm");
    const head = b64({ alg: "HS256", kid: "k1" });
    const body = b64(claims());
    const secret = JSON.stringify(rsa.jwk);
    const mac = createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url");
    expect(code(() => check(`${head}.${body}.${mac}`))).toBe("bad_algorithm");
  });

  it("rejects a key id that the provider does not publish", () => {
    expect(code(() => check(token(claims(), { kid: "unknown" })))).toBe("unknown_key");
  });

  it("rejects a malformed token", () => {
    expect(code(() => check("not-a-token"))).toBe("malformed");
    expect(code(() => check("a.b.c"))).toBe("malformed");
  });

  it("rejects a token without subject or email, and reports an unverified email", () => {
    expect(code(() => check(token(claims({ sub: undefined }))))).toBe("missing_claims");
    expect(code(() => check(token(claims({ email: undefined }))))).toBe("missing_claims");
    expect(check(token(claims({ email_verified: false }))).emailVerified).toBe(false);
  });
});
