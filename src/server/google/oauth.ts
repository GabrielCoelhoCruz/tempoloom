// Google OAuth 2.0 authorization-code flow with PKCE.
// https://developers.google.com/identity/protocols/oauth2/web-server
import { createHash, randomBytes } from "node:crypto";

export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/calendar.freebusy",
] as const;

export interface OAuthClient {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface AuthRequest {
  url: string;
  state: string;
  codeVerifier: string;
}

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";

const base64url = (buf: Buffer) => buf.toString("base64url");

export function buildAuthRequest(
  client: OAuthClient,
  loginHint?: string,
  extraScopes: readonly string[] = [],
): AuthRequest {
  const state = base64url(randomBytes(24));
  const codeVerifier = base64url(randomBytes(48));
  const challenge = base64url(createHash("sha256").update(codeVerifier).digest());
  const params = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: client.redirectUri,
    response_type: "code",
    scope: [...GOOGLE_SCOPES, ...extraScopes].join(" "),
    access_type: "offline",
    include_granted_scopes: "true",
    prompt: "consent",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  if (loginHint) params.set("login_hint", loginHint);
  return { url: `${AUTH_ENDPOINT}?${params}`, state, codeVerifier };
}

export interface TokenSet {
  accessToken: string;
  expiresAt: number;
  refreshToken?: string;
  scope: string;
  idToken?: string;
}

export interface GoogleIdentity {
  sub: string;
  email: string;
  name: string;
  picture?: string;
  /** Google confirmed that the user owns the email. */
  emailVerified: boolean;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope: string;
  id_token?: string;
  token_type: string;
}

export class OAuthError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

async function tokenRequest(body: URLSearchParams, now: number): Promise<TokenSet> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = (await res.json().catch(() => ({}))) as Partial<TokenResponse> & {
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !json.access_token) {
    throw new OAuthError(
      json.error ?? `http_${res.status}`,
      json.error_description ?? "Token request failed",
    );
  }
  return {
    accessToken: json.access_token,
    // Refresh one minute early so a request never starts with a token about to expire.
    expiresAt: now + ((json.expires_in ?? 3600) - 60) * 1000,
    ...(json.refresh_token ? { refreshToken: json.refresh_token } : {}),
    scope: json.scope ?? "",
    ...(json.id_token ? { idToken: json.id_token } : {}),
  };
}

export function exchangeCode(
  client: OAuthClient,
  code: string,
  codeVerifier: string,
  now = Date.now(),
): Promise<TokenSet> {
  return tokenRequest(
    new URLSearchParams({
      code,
      client_id: client.clientId,
      client_secret: client.clientSecret,
      redirect_uri: client.redirectUri,
      grant_type: "authorization_code",
      code_verifier: codeVerifier,
    }),
    now,
  );
}

export function refreshAccessToken(
  client: Pick<OAuthClient, "clientId" | "clientSecret">,
  refreshToken: string,
  now = Date.now(),
): Promise<TokenSet> {
  return tokenRequest(
    new URLSearchParams({
      refresh_token: refreshToken,
      client_id: client.clientId,
      client_secret: client.clientSecret,
      grant_type: "refresh_token",
    }),
    now,
  );
}

/** Revokes a refresh or access token, and with it the user's grant to this client. */
export async function revokeToken(token: string): Promise<void> {
  const res = await fetch(REVOKE_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }),
  });
  if (!res.ok) throw new OAuthError(`http_${res.status}`, "Token revocation failed");
}

/**
 * Reads the identity claims from an ID token that came straight from Google's
 * token endpoint over TLS. Per Google's guidance, the signature check is not
 * needed for a token received directly from that endpoint.
 */
export function identityFromIdToken(idToken: string): GoogleIdentity {
  const payload = idToken.split(".")[1];
  if (!payload) throw new OAuthError("invalid_id_token", "Malformed ID token");
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<
    string,
    unknown
  >;
  if (typeof claims.sub !== "string" || typeof claims.email !== "string") {
    throw new OAuthError("invalid_id_token", "ID token has no subject or email");
  }
  return {
    sub: claims.sub,
    email: claims.email,
    name: typeof claims.name === "string" ? claims.name : claims.email,
    ...(typeof claims.picture === "string" ? { picture: claims.picture } : {}),
    emailVerified: claims.email_verified === true || claims.email_verified === "true",
  };
}
