// Runs Google's consent flow once for the test account, runs a command with the
// refresh token in its environment, then revokes the token. The token is never
// written to disk.
//
//   GOOGLE_OAUTH_CLIENT_JSON='{"web":{...}}' GOOGLE_TEST_ACCOUNT_EMAIL=tester@example.com \
//     node scripts/google-oauth-login.ts -- <command...>
//
// The OAuth client must list http://127.0.0.1:<PORT>/auth/google/callback as a
// redirect URI. Open the printed URL in a browser that reaches that port, and
// sign in as GOOGLE_TEST_ACCOUNT_EMAIL; another account stops the run.
import { type ChildProcess, spawn } from "node:child_process";
import { createServer } from "node:http";
import {
  buildAuthRequest,
  exchangeCode,
  GOOGLE_SCOPES,
  identityFromIdToken,
  revokeToken,
  type TokenSet,
} from "../src/server/google/oauth.ts";

// The test driver creates its test calendar, which needs this scope. It does
// not limit the driver: calendar.events (GOOGLE_SCOPES) reaches the events of
// every calendar the account can write to. The driver's own check (owner and a
// marker it sets at creation) keeps it to the test calendar.
const TEST_SCOPES = ["https://www.googleapis.com/auth/calendar.app.created"];
const CONSENT_TIMEOUT_MS = 10 * 60_000;

const port = Number(process.env.GOOGLE_OAUTH_LOGIN_PORT ?? 8798);
const dashes = process.argv.indexOf("--");
const command = dashes === -1 ? [] : process.argv.slice(dashes + 1);
const raw = process.env.GOOGLE_OAUTH_CLIENT_JSON;
const expected = process.env.GOOGLE_TEST_ACCOUNT_EMAIL?.trim().toLowerCase();
if (!raw || !expected || !command.length) {
  console.error(
    "usage: GOOGLE_OAUTH_CLIENT_JSON=... GOOGLE_TEST_ACCOUNT_EMAIL=... node scripts/google-oauth-login.ts -- <command...>",
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
const auth = buildAuthRequest(client, expected, TEST_SCOPES);

const tokens = await new Promise<TokenSet>((resolve, reject) => {
  const fail = (err: Error) => {
    clearTimeout(timer);
    server.close();
    reject(err);
  };
  const timer = setTimeout(
    () => fail(new Error("No consent within 10 minutes")),
    CONSENT_TIMEOUT_MS,
  );
  const server = createServer((req, res) => {
    const reply = (status: number, text: string) =>
      res.writeHead(status, { "content-type": "text/plain" }).end(text);
    if (!req.url?.startsWith("/auth/google/callback")) {
      res.writeHead(302, { location: auth.url }).end();
      return;
    }
    const q = new URL(req.url, client.redirectUri).searchParams;
    // A stale or foreign callback is not ours: ignore it and keep waiting.
    if (q.get("state") !== auth.state) return reply(404, "Unknown sign-in.");
    const code = q.get("code");
    if (!code) {
      reply(400, "No code.");
      return fail(new Error(`Consent failed: ${q.get("error") ?? "no code"}`));
    }
    const granted = new Set((q.get("scope") ?? "").split(" "));
    const missing = [...GOOGLE_SCOPES, ...TEST_SCOPES].filter(
      (s) => s.startsWith("https:") && !granted.has(s),
    );
    if (missing.length) {
      reply(400, `Missing access: ${missing.join(", ")}`);
      return fail(new Error(`Access not granted: ${missing.join(", ")}`));
    }
    exchangeCode(client, code, auth.codeVerifier).then(
      (t) => {
        reply(200, "Done. You can close this tab.");
        clearTimeout(timer);
        server.close();
        resolve(t);
      },
      (err: Error) => {
        reply(400, "Token exchange failed.");
        fail(err);
      },
    );
  });
  server.on("error", fail);
  server.listen(port, "127.0.0.1", () => {
    console.log(`Open http://127.0.0.1:${port}/ and approve the access as ${expected}.`);
  });
});

const refreshToken = tokens.refreshToken;
if (!refreshToken) throw new Error("Google returned no refresh token");
let child: ChildProcess | undefined;
let finished = false;
/** Revokes the grant (and the refresh token with it), then exits. */
const finish = async (code: number, why?: string): Promise<void> => {
  if (finished) return;
  finished = true;
  if (why) console.error(why);
  try {
    await revokeToken(refreshToken);
  } catch (err) {
    console.error(`Revoking the refresh token failed: ${(err as Error).message}`);
    code ||= 1;
  }
  process.exit(code);
};
// From here on, every way out revokes the token. The child runs in its own
// process group, so a Ctrl-C reaches only this process: the first signal goes
// once to the child's group and the token is revoked when the child exits; a
// second signal stops the child and revokes at once.
let forwarded = false;
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    const pid = child?.exitCode === null ? child.pid : undefined;
    if (pid && !forwarded) {
      forwarded = true;
      process.kill(-pid, signal);
      return;
    }
    if (pid) process.kill(-pid, "SIGKILL");
    void finish(1, `Stopped by ${signal}.`);
  });
}
process.on("uncaughtException", (err) => void finish(1, `Failed: ${err.message}`));
process.on("unhandledRejection", (err) => void finish(1, `Failed: ${String(err)}`));

try {
  if (!tokens.idToken) throw new Error("Google returned no ID token");
  const identity = identityFromIdToken(tokens.idToken);
  if (identity.email.toLowerCase() !== expected)
    throw new Error(`Signed in as ${identity.email}, not ${expected}; stopped.`);
  if (!identity.emailVerified)
    throw new Error(`Google has not verified ${identity.email}; stopped.`);
  console.log("Consent done. Running the command.");
  child = spawn(command[0] as string, command.slice(1), {
    stdio: "inherit",
    detached: true,
    env: {
      ...process.env,
      GOOGLE_CLIENT_ID: client.clientId,
      GOOGLE_CLIENT_SECRET: client.clientSecret,
      GOOGLE_REFRESH_TOKEN: refreshToken,
    },
  });
  child.on("error", (err) => void finish(1, `Could not run ${command[0]}: ${err.message}`));
  child.on("exit", (code, signal) => void finish(code ?? (signal ? 1 : 0)));
} catch (err) {
  await finish(1, (err as Error).message);
}
