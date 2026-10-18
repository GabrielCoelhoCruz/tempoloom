// Shared steps for account settings and delegated access: they drive the
// Account page and the account menu like a user would.
import type { Page } from "@playwright/test";
import { expect } from "./fixtures.ts";

export async function openAccount(p: Page): Promise<void> {
  await p.getByRole("link", { name: "Account", exact: true }).click();
  await expect(p.getByTestId("account-page")).toBeVisible();
}

/** The status line of the Account page. */
export const accountMessage = (p: Page) => p.getByTestId("account-message");

/** A row of the added-accounts list. */
export const accountRow = (p: Page, email: string) => p.locator(`[data-account="${email}"]`);
/** A search result in the delegate search. */
export const candidate = (p: Page, email: string) => p.locator(`[data-candidate="${email}"]`);
/** A row of the owner's delegate list. */
export const delegateRow = (p: Page, email: string) => p.locator(`[data-delegate="${email}"]`);
/** A row of the API key list. */
export const keyRow = (p: Page, name: string) => p.locator(`[data-key="${name}"]`);

/** The owner gives `email` delegated access: search, give access, confirm. */
export async function giveAccess(p: Page, email: string): Promise<void> {
  await openAccount(p);
  await p.getByLabel("Search team members").fill(email);
  await candidate(p, email).getByRole("button", { name: "Give access" }).click();
  const dialog = p.getByRole("dialog");
  await expect(dialog).toContainText("will see and change your Tempoloom data");
  await dialog.getByRole("button", { name: "Give access" }).click();
  await expect(delegateRow(p, email)).toBeVisible();
}

export async function openAccountMenu(p: Page): Promise<void> {
  await p.getByRole("button", { name: "Account menu" }).click();
  await expect(p.getByRole("menu")).toBeVisible();
}

/** The delegate switches into `ownerName`'s account from the account menu. */
export async function switchTo(p: Page, ownerName: string): Promise<void> {
  await openAccountMenu(p);
  await p.getByRole("menuitem", { name: `Switch to ${ownerName}'s account` }).click();
  await expect(p.getByTestId("acting-banner")).toContainText(
    `You are acting in ${ownerName}'s account`,
  );
}

/** The delegate leaves the acting session from the account menu. */
export async function exitActing(p: Page, ownerName: string): Promise<void> {
  await openAccountMenu(p);
  await p.getByRole("menuitem", { name: `Exit ${ownerName}'s account` }).click();
  await expect(p.getByTestId("acting-banner")).toHaveCount(0);
}

/** Fills and submits the add-account form with CalDAV credentials. */
export async function addCalDavAccount(
  p: Page,
  a: { url: string; username: string; password: string; email: string },
): Promise<void> {
  await openAccount(p);
  await p.getByRole("button", { name: "Add another account" }).click();
  const form = p.getByTestId("add-account-form");
  await form.getByLabel("CalDAV server URL").fill(a.url);
  await form.getByLabel("User name", { exact: true }).fill(a.username);
  await form.getByLabel("Password", { exact: true }).fill(a.password);
  await form.getByLabel(/^Email/).fill(a.email);
  await form.getByRole("button", { name: "Add account" }).click();
}

/** Creates an API key and returns its secret, which the page shows once. */
export async function createKey(
  p: Page,
  name: string,
  expires: "30 days" | "90 days" | "1 year" | "Never" = "Never",
): Promise<string> {
  await openAccount(p);
  const form = p.getByTestId("key-form");
  await form.getByLabel("Key name").fill(name);
  await form.getByLabel("Expires").selectOption({ label: expires });
  await form.getByRole("button", { name: "Generate" }).click();
  const secret = p.getByTestId("new-key").locator("code");
  await expect(secret).toHaveText(/^tl-[a-z0-9]{6}(-[a-z0-9]{6}){3}$/);
  return (await secret.textContent()) ?? "";
}

/** Status codes of API calls made from the page, for the paths the UI must refuse. */
export function statuses(
  p: Page,
  calls: { method: string; url: string; body?: unknown }[],
): Promise<{ status: number; error?: string }[]> {
  return p.evaluate(
    (list) =>
      Promise.all(
        list.map(async (c) => {
          const res = await fetch(c.url, {
            method: c.method,
            headers: { "content-type": "application/json" },
            ...(c.body === undefined ? {} : { body: JSON.stringify(c.body) }),
          });
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          return { status: res.status, ...(data.error ? { error: data.error } : {}) };
        }),
      ),
    calls,
  );
}
