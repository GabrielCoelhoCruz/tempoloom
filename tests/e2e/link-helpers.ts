// Shared steps for team booking links: a team of several people, the link
// editor, and reading the offered times on a booking page.
import type { Locator, Page } from "@playwright/test";
import { expect, local } from "./fixtures.ts";
import { accept, invite, joinLink, member } from "./team-helpers.ts";

interface Joiner {
  email: string;
  signIn: () => Promise<Page>;
}

/**
 * A team: the user of `page` (admin) and every person in `people`. Each person
 * signs in first, then accepts the emailed invitation. Returns their pages, in order.
 */
export async function teamOf(
  page: Page,
  signIn: () => Promise<void>,
  people: Joiner[],
  mail: { message(to: string, s: RegExp): Promise<{ text: string }> },
): Promise<Page[]> {
  const pages: Page[] = [];
  for (const p of people) pages.push(await p.signIn());
  await signIn();
  await invite(
    page,
    people.map((p) => p.email),
  );
  for (const [i, p] of people.entries()) {
    const pp = pages[i] as Page;
    await accept(pp, joinLink((await mail.message(p.email, /invited you/)).text));
  }
  await page.reload();
  for (const p of people) await expect(member(page, p.email)).toContainText("active");
  return pages;
}

/** Weekday meeting hours start at `from` (Settings > Hours). */
export async function meetingHoursFrom(p: Page, from: string): Promise<void> {
  await p.getByRole("link", { name: "Settings" }).click();
  for (const d of [1, 2, 3, 4, 5]) {
    await p.getByTestId(`range-meeting-${d}-0`).locator("input").first().fill(from);
  }
  await p.getByRole("button", { name: "Save meeting hours" }).click();
  await expect(p.getByTestId("settings-message")).toHaveText("Saved");
}

/** A custom hours set on weekdays from `from` to 17:00 (Settings > Hours). */
export async function customHours(p: Page, name: string, from: string): Promise<void> {
  await p.getByRole("link", { name: "Settings" }).click();
  await p.getByLabel("New hours set name").fill(name);
  await p.getByRole("button", { name: "+ Custom hours" }).click();
  for (const d of [1, 2, 3, 4, 5]) {
    await p.getByTestId(`range-custom-${d}-0`).locator("input").first().fill(from);
  }
  await p.getByRole("button", { name: `Save ${name.toLowerCase()}` }).click();
  await expect(p.getByTestId("settings-message")).toHaveText("Saved");
}

/** Opens the editor of a link the user owns or organizes; returns the editor. */
export async function editLink(p: Page, title: string): Promise<Locator> {
  await p.getByRole("link", { name: "Booking links" }).click();
  await p.locator(`[data-link-title="${title}"]`).getByRole("button", { name: "Edit" }).click();
  const ed = p.getByTestId("link-editor");
  await expect(ed).toBeVisible();
  return ed;
}

export async function saveLink(p: Page): Promise<void> {
  const ed = p.getByTestId("link-editor");
  await ed.getByRole("button", { name: "Save link" }).click();
  await expect(p.getByTestId("link-saved")).toBeVisible();
}

/** The editor row of an organizer, or of a round-robin pool member, by email. */
export const organizer = (p: Page, email: string) =>
  p.getByTestId("link-editor").locator(`[data-organizer="${email}"]`);
export const poolMember = (p: Page, email: string) =>
  p.getByTestId("link-editor").locator(`[data-pool-member="${email}"]`);

export async function addOrganizer(p: Page, email: string): Promise<void> {
  await p.getByTestId("link-editor").getByLabel("Add organizer").selectOption({ label: email });
  await expect(organizer(p, email)).toBeVisible();
}

export async function addToPool(p: Page, email: string): Promise<void> {
  await p.getByTestId("link-editor").getByLabel("Add to pool").selectOption({ label: email });
  await expect(poolMember(p, email)).toBeVisible();
}

/** Offered start times ("HH:MM", local) on one date of an open booking page. */
export async function offered(v: Page, date: string): Promise<string[]> {
  await expect(v.getByTestId("times")).toBeVisible();
  const starts = await v
    .locator('[data-testid="times"] button[data-start]')
    .evaluateAll((els) => els.map((e) => Number(e.getAttribute("data-start"))));
  return starts.filter((s) => local(s).startsWith(date)).map((s) => local(s).slice(11));
}
