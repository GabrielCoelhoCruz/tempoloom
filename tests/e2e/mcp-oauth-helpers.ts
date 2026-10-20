// An MCP client that signs in with OAuth 2.1, as remote MCP clients do: the
// official MCP TypeScript SDK client, with dynamic client registration, PKCE,
// and the user's "Allow access" on Tempoloom's consent page in the browser.

import {
  type OAuthClientProvider,
  UnauthorizedError,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Page } from "@playwright/test";
import { BASE_URL, expect } from "./fixtures.ts";

/** The client's redirect URI: loopback, never reached; the test catches the redirect in the browser. */
const REDIRECT = "http://127.0.0.1:9/callback";

/** Keeps the client's registration, tokens and PKCE verifier in memory. */
class MemoryProvider implements OAuthClientProvider {
  info: OAuthClientInformationMixed | undefined;
  saved: OAuthTokens | undefined;
  verifier = "";
  authUrl: URL | undefined;
  readonly name: string;
  constructor(name: string) {
    this.name = name;
  }
  readonly nonce = `st-${Math.random().toString(36).slice(2)}`;
  state() {
    return this.nonce;
  }
  get redirectUrl() {
    return REDIRECT;
  }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: this.name,
      redirect_uris: [REDIRECT],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }
  clientInformation() {
    return this.info;
  }
  saveClientInformation(info: OAuthClientInformationMixed) {
    this.info = info;
  }
  tokens() {
    return this.saved;
  }
  saveTokens(tokens: OAuthTokens) {
    this.saved = tokens;
  }
  redirectToAuthorization(url: URL) {
    this.authUrl = url;
  }
  saveCodeVerifier(v: string) {
    this.verifier = v;
  }
  codeVerifier() {
    return this.verifier;
  }
}

export interface OAuthMcp {
  client: Client;
  provider: MemoryProvider;
  /** Calls a tool and returns its structured content; a tool error fails the test. */
  tool<T = Record<string, unknown>>(name: string, args?: Record<string, unknown>): Promise<T>;
  /** Calls a tool; the text of a tool error, or "" when it succeeded. */
  toolError(name: string, args?: Record<string, unknown>): Promise<string>;
}

const mcpUrl = () => new URL(`${BASE_URL}/mcp`);

// The SDK's transport type and its Transport interface differ only under
// exactOptionalPropertyTypes (sessionId?: string).
type Transport = Parameters<Client["connect"]>[0];
const transport = (provider: MemoryProvider) =>
  new StreamableHTTPClientTransport(mcpUrl(), { authProvider: provider }) as unknown as Transport;

async function open(provider: MemoryProvider): Promise<Client> {
  const client = new Client({ name: provider.name, version: "1.0.0" });
  await client.connect(transport(provider));
  return client;
}

/**
 * Starts the OAuth flow of a new client: it registers itself and asks for the
 * user's consent. Returns the provider with the authorization URL to open.
 */
export async function startOAuth(name: string): Promise<MemoryProvider> {
  const provider = new MemoryProvider(name);
  const client = new Client({ name, version: "1.0.0" });
  await expect(client.connect(transport(provider))).rejects.toThrow(UnauthorizedError);
  expect(provider.info?.client_id, "dynamic client registration").toBeTruthy();
  expect(provider.authUrl?.toString()).toContain(`${BASE_URL}/`);
  return provider;
}

/**
 * Opens the consent page in the signed-in browser and clicks a button. Returns
 * the query of the redirect back to the client (code and state, or an error).
 */
export async function answerConsent(
  page: Page,
  provider: MemoryProvider,
  button: "Allow access" | "Cancel",
): Promise<URLSearchParams> {
  await page.route(`${REDIRECT}**`, (r) => r.fulfill({ body: "You can close this window." }));
  await page.goto(provider.authUrl?.toString() ?? "");
  const consent = page.getByTestId("oauth-consent");
  await expect(consent).toContainText(provider.name);
  const redirected = page.waitForRequest((r) => r.url().startsWith(REDIRECT));
  await consent.getByRole("button", { name: button }).click();
  const back = new URL((await redirected).url());
  await page.unroute(`${REDIRECT}**`);
  // Back in Tempoloom, as the user would be after the AI tool's window.
  await page.goto("/");
  await expect(page.getByTestId("app-shell")).toBeVisible();
  return back.searchParams;
}

/** A connected client: the code exchanged for tokens with the PKCE verifier. */
export async function finishOAuth(provider: MemoryProvider, code: string): Promise<OAuthMcp> {
  await new StreamableHTTPClientTransport(mcpUrl(), { authProvider: provider }).finishAuth(code);
  expect(provider.saved?.access_token).toBeTruthy();
  const client = await open(provider);
  const call = (name: string, args: Record<string, unknown> = {}) =>
    client.callTool({ name, arguments: args }) as Promise<{
      content: { type: string; text: string }[];
      structuredContent?: Record<string, unknown>;
      isError?: boolean;
    }>;
  return {
    client,
    provider,
    async tool<T>(name: string, args: Record<string, unknown> = {}) {
      const r = await call(name, args);
      if (r.isError) throw new Error(`${name}: ${r.content[0]?.text}`);
      return r.structuredContent as T;
    },
    async toolError(name: string, args: Record<string, unknown> = {}) {
      const r = await call(name, args);
      return r.isError ? (r.content[0]?.text ?? "error") : "";
    },
  };
}

/** Registers a client, allows access on the consent page, and connects. */
export async function oauthConnect(page: Page, name: string): Promise<OAuthMcp> {
  const provider = await startOAuth(name);
  const back = await answerConsent(page, provider, "Allow access");
  expect(back.get("error")).toBeNull();
  return finishOAuth(provider, back.get("code") ?? "");
}

/** A raw MCP call with a bearer token: the HTTP status only. */
export async function statusWith(token: string): Promise<number> {
  const res = await fetch(mcpUrl(), {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  return res.status;
}

/** A refresh at the token endpoint: the HTTP status and the OAuth error. */
export async function refreshWith(
  provider: MemoryProvider,
): Promise<{ status: number; error?: string }> {
  const res = await fetch(`${BASE_URL}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: provider.saved?.refresh_token ?? "",
      client_id: provider.info?.client_id ?? "",
    }),
  });
  const body = (await res.json()) as { error?: string };
  return { status: res.status, ...(body.error ? { error: body.error } : {}) };
}
