// OAuth 2.0 for Google service accounts (signed JWT bearer grant).
// https://developers.google.com/identity/protocols/oauth2/service-account
import { createSign } from "node:crypto";
import { z } from "zod";
import { OAuthError, type TokenSet } from "./oauth.ts";

const keySchema = z.object({
  type: z.literal("service_account"),
  client_email: z.string().min(1),
  private_key: z.string().min(1),
  token_uri: z.url().default("https://oauth2.googleapis.com/token"),
});

export type ServiceAccountKey = z.infer<typeof keySchema>;

/** Full calendar access: the account creates and deletes its own test calendars. */
export const SERVICE_ACCOUNT_SCOPES = ["https://www.googleapis.com/auth/calendar"] as const;

export function parseServiceAccountKey(json: string): ServiceAccountKey {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error("Service account key is not valid JSON");
  }
  const parsed = keySchema.safeParse(raw);
  if (!parsed.success) throw new Error("Service account key is missing required fields");
  return parsed.data;
}

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");

export async function serviceAccountToken(
  key: ServiceAccountKey,
  opts: { scopes?: readonly string[]; subject?: string; now?: number } = {},
): Promise<TokenSet> {
  const now = opts.now ?? Date.now();
  const iat = Math.floor(now / 1000);
  const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({
    iss: key.client_email,
    scope: (opts.scopes ?? SERVICE_ACCOUNT_SCOPES).join(" "),
    aud: key.token_uri,
    iat,
    exp: iat + 3600,
    ...(opts.subject ? { sub: opts.subject } : {}),
  })}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(key.private_key, "base64url");
  const res = await fetch(key.token_uri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${signature}`,
    }),
  });
  const json = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
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
    expiresAt: now + ((json.expires_in ?? 3600) - 60) * 1000,
    scope: (opts.scopes ?? SERVICE_ACCOUNT_SCOPES).join(" "),
  };
}
