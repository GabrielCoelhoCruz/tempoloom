// Runs Google's consent flow once for a test account, then runs a command with
// the refresh token in its environment. The token is never written to disk.
//
//   GOOGLE_OAUTH_CLIENT_JSON='{"web":{...}}' node scripts/google-oauth-login.ts -- <command...>
//
// The OAuth client must list http://127.0.0.1:<PORT>/auth/google/callback as a
// redirect URI. Open the printed URL in a browser that reaches that port.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import {
  buildAuthRequest,
  exchangeCode,
  GOOGLE_SCOPES,
  identityFromIdToken,
} from "../src/server/google/oauth.ts";

// The test driver creates and empties its own calendar; this scope reaches only
// calendars this client created, never the account's other calendars.
const TEST_SCOPE = "https://www.googleapis.com/auth/calendar.app.created";

const port = Number(process.env.GOOGLE_OAUTH_LOGIN_PORT ?? 8798);
const command = process.argv.slice(process.argv.indexOf("--") + 1);
const raw = process.env.GOOGLE_OAUTH_CLIENT_JSON;
if (!raw || !command.length) {
  console.error(
    "usage: GOOGLE_OAUTH_CLIENT_JSON=... node scripts/google-oauth-login.ts -- <command...>",
  );
  process.exit(2);
}
const file = JSON.parse(raw) as { web?: { client_id: string; client_secret: string } };
if (!file.web) throw new Error("GOOGLE_OAUTH_CLIENT_JSON is not a web OAuth client");
const client = {
  clientId: file.web.client_id,
  clientSecret: file.web.client_secret,
  redirectUri: `http://127.0.0.1:${port}/auth/google/callback`,
};

const auth = buildAuthRequest(client);
const url = new URL(auth.url);
url.searchParams.set("scope", [...GOOGLE_SCOPES, TEST_SCOPE].join(" "));

const tokens = await new Promise<Awaited<ReturnType<typeof exchangeCode>>>((resolve, reject) => {
  const server = createServer((req, res) => {
    const q = new URL(req.url ?? "/", client.redirectUri).searchParams;
    if (!req.url?.startsWith("/auth/google/callback")) {
      res.writeHead(302, { location: url.toString() }).end();
      return;
    }
    const done = (text: string, err?: Error) => {
      res.writeHead(err ? 400 : 200, { "content-type": "text/plain" }).end(text);
      server.close();
      if (err) reject(err);
    };
    if (q.get("state") !== auth.state) return done("State mismatch.", new Error("state mismatch"));
    const code = q.get("code");
    if (!code) return done("No code.", new Error(q.get("error") ?? "no code"));
    const granted = new Set((q.get("scope") ?? "").split(" "));
    const missing = [...GOOGLE_SCOPES, TEST_SCOPE].filter(
      (s) => s.startsWith("https:") && !granted.has(s),
    );
    if (missing.length)
      return done(`Missing access: ${missing.join(", ")}`, new Error("scopes missing"));
    exchangeCode(client, code, auth.codeVerifier).then(
      (t) => {
        done("Done. You can close this tab.");
        resolve(t);
      },
      (err: Error) => done("Token exchange failed.", err),
    );
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`Open http://127.0.0.1:${port}/ and approve the access.`);
  });
});
if (!tokens.refreshToken || !tokens.idToken) throw new Error("Google returned no refresh token");
const identity = identityFromIdToken(tokens.idToken);
console.log("Consent done. Running the command.");

const child = spawn(command[0] as string, command.slice(1), {
  stdio: "inherit",
  env: {
    ...process.env,
    GOOGLE_CLIENT_ID: client.clientId,
    GOOGLE_CLIENT_SECRET: client.clientSecret,
    GOOGLE_REFRESH_TOKEN: tokens.refreshToken,
    GOOGLE_ACCOUNT_EMAIL: identity.email,
  },
});
child.on("exit", (code) => process.exit(code ?? 1));
