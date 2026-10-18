// OpenID Connect relying party for single sign-on: discovery, the
// authorization-code flow with PKCE, and ID token verification with the
// provider's published keys (OpenID Connect Core 1.0, section 3.1.3.7).
import {
  constants,
  createHash,
  createPublicKey,
  type JsonWebKey,
  randomBytes,
  verify,
} from "node:crypto";

export class OidcError extends Error {
  readonly code: string;
  constructor(code: string, message = code) {
    super(message);
    this.code = code;
  }
}

export interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  token_endpoint_auth_methods_supported?: string[];
}

export interface OidcClient {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface IdClaims {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string;
}

export type Jwk = JsonWebKey & { kid?: string };

const CACHE_MS = 10 * 60_000;
const SKEW_S = 60;
const discoveries = new Map<string, { at: number; doc: Discovery }>();
const keySets = new Map<string, { at: number; keys: Jwk[] }>();

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new OidcError("provider_unreachable", `${url} answered ${res.status}`);
  return res.json();
}

/** Reads the provider's discovery document; its issuer must match exactly. */
export async function discover(issuer: string, now = Date.now()): Promise<Discovery> {
  const cached = discoveries.get(issuer);
  if (cached && cached.at > now - CACHE_MS) return cached.doc;
  let doc: Partial<Discovery>;
  try {
    doc = (await getJson(
      `${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`,
    )) as Partial<Discovery>;
  } catch (err) {
    if (err instanceof OidcError) throw err;
    throw new OidcError("provider_unreachable", String(err));
  }
  if (doc.issuer !== issuer) throw new OidcError("bad_discovery", "Issuer does not match");
  if (!doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) {
    throw new OidcError("bad_discovery", "Discovery document is incomplete");
  }
  const full = doc as Discovery;
  discoveries.set(issuer, { at: now, doc: full });
  return full;
}

/** The provider's signing keys; read again when a token names an unknown key. */
export async function signingKeys(d: Discovery, kid: string | undefined, now = Date.now()) {
  const cached = keySets.get(d.jwks_uri);
  if (cached && cached.at > now - CACHE_MS && (!kid || cached.keys.some((k) => k.kid === kid))) {
    return cached.keys;
  }
  const { keys } = (await getJson(d.jwks_uri)) as { keys?: Jwk[] };
  const list = Array.isArray(keys) ? keys : [];
  keySets.set(d.jwks_uri, { at: now, keys: list });
  return list;
}

const b64 = (buf: Buffer) => buf.toString("base64url");

export function authRequest(
  d: Discovery,
  client: OidcClient,
  loginHint: string,
): { url: string; state: string; nonce: string; codeVerifier: string } {
  const state = b64(randomBytes(24));
  const nonce = b64(randomBytes(24));
  const codeVerifier = b64(randomBytes(48));
  const url = new URL(d.authorization_endpoint);
  for (const [k, v] of Object.entries({
    client_id: client.clientId,
    redirect_uri: client.redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state,
    nonce,
    code_challenge: b64(createHash("sha256").update(codeVerifier).digest()),
    code_challenge_method: "S256",
    login_hint: loginHint,
  })) {
    url.searchParams.set(k, v);
  }
  return { url: url.toString(), state, nonce, codeVerifier };
}

/** Exchanges the code for tokens and returns the ID token. */
export async function exchangeCode(
  d: Discovery,
  client: OidcClient,
  code: string,
  codeVerifier: string,
): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: client.redirectUri,
    code_verifier: codeVerifier,
  });
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    accept: "application/json",
  };
  const methods = d.token_endpoint_auth_methods_supported ?? ["client_secret_basic"];
  if (methods.includes("client_secret_basic")) {
    const enc = (v: string) => encodeURIComponent(v);
    headers.authorization = `Basic ${Buffer.from(`${enc(client.clientId)}:${enc(client.clientSecret)}`).toString("base64")}`;
  } else {
    body.set("client_id", client.clientId);
    body.set("client_secret", client.clientSecret);
  }
  const res = await fetch(d.token_endpoint, { method: "POST", headers, body });
  const json = (await res.json().catch(() => ({}))) as { id_token?: string; error?: string };
  if (!res.ok || !json.id_token) {
    throw new OidcError("token_failed", json.error ?? `Token endpoint answered ${res.status}`);
  }
  return json.id_token;
}

const ALGS: Record<string, { hash: string; kty: string; pss?: true; ec?: true }> = {
  RS256: { hash: "sha256", kty: "RSA" },
  RS384: { hash: "sha384", kty: "RSA" },
  RS512: { hash: "sha512", kty: "RSA" },
  PS256: { hash: "sha256", kty: "RSA", pss: true },
  PS384: { hash: "sha384", kty: "RSA", pss: true },
  PS512: { hash: "sha512", kty: "RSA", pss: true },
  ES256: { hash: "sha256", kty: "EC", ec: true },
  ES384: { hash: "sha384", kty: "EC", ec: true },
  ES512: { hash: "sha512", kty: "EC", ec: true },
};

function part(seg: string | undefined): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(Buffer.from(seg ?? "", "base64url").toString("utf8"));
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {}
  throw new OidcError("malformed");
}

/** The key id named in a token's header, to pick the key set. */
export function tokenKeyId(token: string): string | undefined {
  const kid = part(token.split(".")[0]).kid;
  return typeof kid === "string" ? kid : undefined;
}

/**
 * Verifies an ID token: signature with one of `keys` (asymmetric algorithms
 * only), issuer, audience and authorized party, nonce, expiry and issue time.
 */
export function verifyIdToken(
  token: string,
  check: { issuer: string; clientId: string; nonce: string; now: number; keys: Jwk[] },
): IdClaims {
  const segs = token.split(".");
  if (segs.length !== 3) throw new OidcError("malformed");
  const [h, p, s] = segs as [string, string, string];
  const header = part(h);
  const claims = part(p);
  const alg = ALGS[String(header.alg)];
  if (!alg) throw new OidcError("bad_algorithm");
  const kid = typeof header.kid === "string" ? header.kid : undefined;
  const candidates = check.keys.filter(
    (k) => k.kty === alg.kty && (kid === undefined ? true : k.kid === kid),
  );
  if (candidates.length === 0) throw new OidcError("unknown_key");
  const input = Buffer.from(`${h}.${p}`);
  const sig = Buffer.from(s, "base64url");
  const valid = candidates.some((jwk) => {
    try {
      const key = createPublicKey({ key: jwk, format: "jwk" });
      return verify(
        alg.hash,
        input,
        alg.pss
          ? {
              key,
              padding: constants.RSA_PKCS1_PSS_PADDING,
              saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
            }
          : alg.ec
            ? { key, dsaEncoding: "ieee-p1363" }
            : key,
        sig,
      );
    } catch {
      return false;
    }
  });
  if (!valid) throw new OidcError("bad_signature");

  if (claims.iss !== check.issuer) throw new OidcError("bad_issuer");
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(check.clientId)) throw new OidcError("bad_audience");
  if ((aud.length > 1 || claims.azp !== undefined) && claims.azp !== check.clientId) {
    throw new OidcError("bad_audience");
  }
  if (claims.nonce !== check.nonce) throw new OidcError("bad_nonce");
  const nowS = check.now / 1000;
  if (typeof claims.exp !== "number" || claims.exp + SKEW_S < nowS) throw new OidcError("expired");
  if (typeof claims.iat === "number" && claims.iat - SKEW_S > nowS) {
    throw new OidcError("issued_in_future");
  }
  if (typeof claims.sub !== "string" || !claims.sub || typeof claims.email !== "string") {
    throw new OidcError("missing_claims");
  }
  return {
    sub: claims.sub,
    email: claims.email.toLowerCase(),
    emailVerified: claims.email_verified === true || claims.email_verified === "true",
    name: typeof claims.name === "string" && claims.name ? claims.name : claims.email,
  };
}
