// E2E fixtures: a real Tempoloom server, a real Chrome profile that is signed in
// to the Google test account, and a Google Calendar client for assertions.
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type Browser, test as base, chromium, expect, type Page } from "@playwright/test";
import { SecretBox } from "../../src/server/crypto.ts";
import { GoogleCalendarApi } from "../../src/server/google/calendar.ts";
import { refreshAccessToken } from "../../src/server/google/oauth.ts";

const ENV_FILE = process.env.TEMPOLOOM_E2E_ENV ?? join(homedir(), ".config/tempoloom/e2e.env");
const CDP = process.env.TEMPOLOOM_E2E_CDP ?? "http://127.0.0.1:9333";
export const PORT = Number(process.env.TEMPOLOOM_E2E_PORT ?? 8788);
export const BASE_URL = `http://localhost:${PORT}`;

function loadEnv(): Record<string, string> {
  if (!existsSync(ENV_FILE)) {
    throw new Error(`E2E needs ${ENV_FILE}. See tests/e2e/README.md.`);
  }
  const out: Record<string, string> = {};
  for (const line of readFileSync(ENV_FILE, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m?.[1]) out[m[1]] = (m[2] ?? "").replace(/^["']|["']$/g, "");
  }
  for (const k of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "E2E_GOOGLE_EMAIL"]) {
    if (!out[k]) throw new Error(`${ENV_FILE} has no ${k}`);
  }
  return out;
}

export interface AppServer {
  baseUrl: string;
  dataDir: string;
  secretKey: string;
  restart(): Promise<void>;
  /** Server log lines, for failure reports. */
  log: string[];
}

async function waitHealthy(url: string, proc: ChildProcess, log: string[]): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (proc.exitCode !== null) throw new Error(`Server exited:\n${log.join("")}`);
    try {
      if ((await fetch(`${url}/healthz`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Server did not become healthy:\n${log.join("")}`);
}

export interface GoogleChecker {
  api: GoogleCalendarApi;
  email: string;
}

type WorkerFixtures = { env: Record<string, string>; app: AppServer; cdp: Browser };
type TestFixtures = { google: GoogleChecker; signIn: () => Promise<void> };

export const test = base.extend<TestFixtures, WorkerFixtures>({
  env: [async ({}, use) => use(loadEnv()), { scope: "worker" }],

  app: [
    async ({ env }, use) => {
      const dataDir = mkdtempSync(join(tmpdir(), "tempoloom-e2e-"));
      const secretKey = randomBytes(32).toString("base64");
      const log: string[] = [];
      let proc: ChildProcess | undefined;
      const start = async () => {
        proc = spawn(process.execPath, ["src/server/main.ts"], {
          env: {
            ...process.env,
            PORT: String(PORT),
            HOST: "127.0.0.1",
            BASE_URL,
            DATA_DIR: dataDir,
            SECRET_KEY: secretKey,
            GOOGLE_CLIENT_ID: env.GOOGLE_CLIENT_ID,
            GOOGLE_CLIENT_SECRET: env.GOOGLE_CLIENT_SECRET,
            SYNC_INTERVAL_SECONDS: "5",
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
        proc.stdout?.on("data", (b: Buffer) => log.push(b.toString()));
        proc.stderr?.on("data", (b: Buffer) => log.push(b.toString()));
        await waitHealthy(BASE_URL, proc, log);
      };
      const stop = async () => {
        if (!proc || proc.exitCode !== null) return;
        const p = proc;
        await new Promise<void>((r) => {
          p.once("exit", () => r());
          p.kill("SIGTERM");
        });
      };
      await start();
      await use({
        baseUrl: BASE_URL,
        dataDir,
        secretKey,
        log,
        restart: async () => {
          await stop();
          await start();
        },
      });
      await stop();
    },
    { scope: "worker" },
  ],

  cdp: [
    async ({}, use) => {
      const browser = await chromium.connectOverCDP(CDP);
      await use(browser);
      // Disconnect only; the login browser keeps running for the next run.
      await browser.close();
    },
    { scope: "worker" },
  ],

  // Pages open in the signed-in profile so Google recognizes the test account.
  page: async ({ cdp }, use) => {
    const context = cdp.contexts()[0];
    if (!context) throw new Error("The login browser has no default context");
    const page = await context.newPage();
    await use(page);
    await page.close();
  },

  signIn: async ({ page, env }, use) => {
    await use(() => signInWithGoogle(page, env.E2E_GOOGLE_EMAIL as string));
  },

  google: async ({ app, env }, use) => {
    const db = new DatabaseSync(join(app.dataDir, "tempoloom.db"), { readOnly: true });
    const row = db.prepare("SELECT refresh_token FROM google_accounts LIMIT 1").get() as
      | { refresh_token: string }
      | undefined;
    db.close();
    if (!row) throw new Error("No Google account in the database; sign in first");
    const refresh = new SecretBox(app.secretKey).open(row.refresh_token);
    let token: { value: string; exp: number } | undefined;
    const api = new GoogleCalendarApi({
      getAccessToken: async () => {
        if (!token || token.exp < Date.now()) {
          const t = await refreshAccessToken(
            {
              clientId: env.GOOGLE_CLIENT_ID as string,
              clientSecret: env.GOOGLE_CLIENT_SECRET as string,
              redirectUri: `${BASE_URL}/auth/google/callback`,
            },
            refresh,
          );
          token = { value: t.accessToken, exp: t.expiresAt };
        }
        return token.value;
      },
    });
    await use({ api, email: env.E2E_GOOGLE_EMAIL as string });
  },
});

/** Runs the real Google OAuth flow in the signed-in profile. */
export async function signInWithGoogle(page: Page, email: string): Promise<void> {
  await page.goto(BASE_URL);
  await page.getByRole("link", { name: /sign in with google/i }).click();
  await page.waitForURL(/accounts\.google\.com|localhost/);
  for (let step = 0; step < 8 && !page.url().startsWith(BASE_URL); step++) {
    const account = page.getByText(email, { exact: false }).first();
    const advanced = page.getByRole("link", { name: /advanced/i });
    const goTo = page.getByRole("link", { name: /go to .*\(unsafe\)/i });
    const selectAll = page.getByRole("checkbox", { name: /select all/i });
    const cont = page.getByRole("button", { name: /^(continue|allow)$/i });
    await page.waitForLoadState("domcontentloaded");
    if (await goTo.isVisible().catch(() => false)) await goTo.click();
    else if (await advanced.isVisible().catch(() => false)) await advanced.click();
    else if (await selectAll.isVisible().catch(() => false)) {
      if (!(await selectAll.isChecked())) await selectAll.check();
      await cont.click();
    } else if (await cont.isVisible().catch(() => false)) await cont.click();
    else if (await account.isVisible().catch(() => false)) await account.click();
    else await page.waitForTimeout(1000);
    await page.waitForTimeout(800);
  }
  await page.waitForURL(`${BASE_URL}/**`, { timeout: 60_000 });
  await expect(page.getByTestId("app-shell")).toBeVisible();
}

export { expect };
