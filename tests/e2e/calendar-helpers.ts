// Shared steps for calendar settings, mirroring policies, sign-in emails and
// instance limits. They drive the Settings and sign-in pages like a user
// would, and edit raw calendar objects the way another calendar app would.
import type { Page } from "@playwright/test";
import type { ProviderEvent } from "../../src/server/providers/types.ts";
import { addDays } from "../../src/shared/time.ts";
import { type AppServer, at, type CalendarDriver, expect } from "./fixtures.ts";
import { W } from "./helpers.ts";

/** A Radicale user, as the radicale fixture gives it. */
export interface DavUser {
  url: string;
  username: string;
  password: string;
}

const auth = (u: DavUser) =>
  `Basic ${Buffer.from(`${u.username}:${u.password}`).toString("base64")}`;

/** The raw iCalendar text of one event object. */
export async function rawEvent(u: DavUser, url: string): Promise<string> {
  const res = await fetch(url, { headers: { authorization: auth(u) } });
  if (!res.ok) throw new Error(`GET ${url} failed: ${res.status}`);
  return res.text();
}

/** Replaces one event object with an edited copy of its text. */
export async function editRaw(
  u: DavUser,
  url: string,
  edit: (ics: string) => string,
): Promise<void> {
  const res = await fetch(url, {
    method: "PUT",
    headers: { authorization: auth(u), "content-type": "text/calendar" },
    body: edit(await rawEvent(u, url)),
  });
  if (!res.ok) throw new Error(`PUT ${url} failed: ${res.status}`);
}

/** Copies that Tempoloom wrote for a mirroring policy. */
export const copies = (events: ProviderEvent[]) =>
  events
    .filter((e) => e.privateProps.tl === "1" && e.privateProps.tl_key?.startsWith("mirror:"))
    .sort((a, b) => a.start - b.start);

/** Events of the test week W. */
export const week = (c: CalendarDriver) => c.events(at(W, "00:00"), at(addDays(W, 7), "00:00"));

export async function openSettings(page: Page): Promise<void> {
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await expect(page.getByTestId("settings-page")).toBeVisible();
}

/** A row of the connected-calendar list, found by any text in it (name or email). */
export const calendarRow = (page: Page, text: string) =>
  page.getByTestId("calendar-list").locator("[data-calendar]", { hasText: text });

/** A row of the mirroring policy list, by its "source → destination" text. */
export const policyRow = (page: Page, name: string) =>
  page.getByTestId("mirror-list").locator(`[data-mirror="${name}"]`);

export interface PolicyForm {
  from: string;
  to: string;
  show?: string;
  label?: string;
  color?: string;
  /** The refusal message, when the policy must not be created. */
  error?: string;
}

/** Fills the mirroring form in Settings and adds the policy. */
export async function addPolicy(page: Page, p: PolicyForm): Promise<void> {
  await openSettings(page);
  await page.getByRole("button", { name: "Refresh calendar list" }).click();
  const form = page.getByTestId("mirror-form");
  await expect(
    form.getByLabel("Copy events from").locator("option", { hasText: p.from }),
  ).toHaveCount(1);
  await form.getByLabel("Copy events from").selectOption({ label: p.from });
  await form.getByLabel("To").selectOption({ label: p.to });
  if (p.show) await form.getByLabel("Copies show").selectOption({ label: p.show });
  if (p.label) await form.getByLabel("Label").selectOption({ label: p.label });
  if (p.color) await form.getByLabel("Color").selectOption({ label: p.color });
  await form.getByRole("button", { name: "Add mirroring" }).click();
  if (p.error) {
    await expect(page.getByTestId("mirror-message")).toHaveText(p.error);
    return;
  }
  await expect(policyRow(page, `${p.from} → ${p.to}`)).toBeVisible();
}

/** Signs out from the app shell; the sign-in page shows again. */
export async function signOut(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByTestId("caldav-form")).toBeVisible();
}

/** Fills and sends the CalDAV sign-in form; waits for the app unless `wait` is false. */
export async function signInWith(page: Page, u: DavUser, email: string, wait = true) {
  const form = page.getByTestId("caldav-form");
  if (!(await form.isVisible())) await page.goto("/");
  await form.getByLabel("CalDAV server URL").fill(u.url);
  await form.getByLabel("User name", { exact: true }).fill(u.username);
  await form.getByLabel("Password", { exact: true }).fill(u.password);
  await form.getByLabel(/^Email/).fill(email);
  await form.getByRole("button", { name: /sign in with caldav/i }).click();
  if (wait) await expect(page.getByTestId("app-shell")).toBeVisible();
}

/** Adds a calendar that someone shared with one of the user's CalDAV accounts. */
export async function addSharedCalendar(page: Page, url: string, account?: string) {
  await openSettings(page);
  const form = page.getByTestId("shared-calendar-form");
  if (account) await form.getByLabel("Account").selectOption({ label: account });
  await form.getByLabel("Calendar URL").fill(url);
  await form.getByRole("button", { name: "Add shared calendar" }).click();
}

/** Sets an instance limit with the operator CLI; "none" removes it. */
export function setLimit(app: AppServer, name: string, value: number | "none"): void {
  app.cli("limit", "--name", name, "--value", String(value));
}
