// E2E fixtures for single sign-on: a real OpenID Connect identity provider (Dex
// in Docker on loopback, scripts/oidc-server.sh) and a driver that signs a
// person in through its login page in the browser.
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { BrowserContext, Page } from "@playwright/test";
import { test as base, expect, ZONE } from "./fixtures.ts";

const ROOT = join(import.meta.dirname, "../..");
const SCRIPT = join(ROOT, "scripts/oidc-server.sh");

/** Static users of the identity provider: <name>@corp.test. */
export type IdpUser = "u" | "v" | "x" | "m";

export interface Idp {
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Email of a static user. */
  email(user: IdpUser): string;
  /**
   * Starts "Sign in with SSO" in a browser context of its own, signs in on the
   * identity provider's page, and waits for the app.
   */
  signIn(user: IdpUser, from?: string): Promise<Page>;
  /** The same, without waiting for the app: for refused sign-ins. */
  attemptSignIn(user: IdpUser): Promise<Page>;
}

interface OidcEnv {
  issuer: string;
  clientId: string;
  clientSecret: string;
  domain: string;
  passwords: Record<string, string>;
}

export const test = base.extend<{ idp: Idp }, { oidcServer: OidcEnv }>({
  oidcServer: [
    async ({}, use) => {
      execFileSync(SCRIPT, ["start"], { stdio: "ignore" });
      const env = Object.fromEntries(
        execFileSync(SCRIPT, ["env"], { encoding: "utf8" })
          .trim()
          .split("\n")
          .map((l) => l.split(/=(.*)/s).slice(0, 2)),
      ) as Record<string, string>;
      await use({
        issuer: env.OIDC_ISSUER ?? "",
        clientId: env.OIDC_CLIENT_ID ?? "",
        clientSecret: env.OIDC_CLIENT_SECRET ?? "",
        domain: env.OIDC_DOMAIN ?? "",
        passwords: Object.fromEntries(
          Object.entries(env)
            .filter(([k]) => k.startsWith("OIDC_PASSWORD_"))
            .map(([k, v]) => [k.slice("OIDC_PASSWORD_".length), v]),
        ),
      });
      if (!process.env.TEMPOLOOM_E2E_KEEP_OIDC) execFileSync(SCRIPT, ["stop"], { stdio: "ignore" });
    },
    { scope: "worker" },
  ],

  idp: async ({ oidcServer, browser, app }, use) => {
    const contexts: BrowserContext[] = [];
    const email = (user: IdpUser) => `${user}@${oidcServer.domain}`;
    const go = async (user: IdpUser, wait: boolean, from = "/") => {
      const ctx = await browser.newContext({
        timezoneId: ZONE,
        locale: "en-GB",
        baseURL: app.baseUrl,
      });
      contexts.push(ctx);
      const page = await ctx.newPage();
      // A signed-out visit to `from` shows the sign-in page there.
      await page.goto(from);
      const form = page.getByTestId("sso-form");
      await form.getByLabel("Work email").fill(email(user));
      await form.getByRole("button", { name: "Sign in with SSO" }).click();
      // The identity provider's own login page.
      await page.waitForURL((u) => u.href.startsWith(oidcServer.issuer));
      await page.getByLabel("Email Address").fill(email(user));
      await page.getByLabel("Password").fill(oidcServer.passwords[user] ?? "");
      await page.getByRole("button", { name: "Login" }).click();
      await page.waitForURL((u) => u.href.startsWith(app.baseUrl));
      if (wait) await expect(page.getByTestId("app-shell")).toBeVisible();
      return page;
    };
    await use({
      issuer: oidcServer.issuer,
      clientId: oidcServer.clientId,
      clientSecret: oidcServer.clientSecret,
      email,
      signIn: (user, from) => go(user, true, from),
      attemptSignIn: (user) => go(user, false),
    });
    for (const c of contexts) await c.close();
  },
});

export { expect };
