// Shared steps for team scenarios: they drive the team page like a user would.
import type { Page } from "@playwright/test";
import { expect } from "./fixtures.ts";

export async function openTeam(p: Page): Promise<void> {
  await p.getByRole("link", { name: "Team", exact: true }).click();
  await expect(p.getByTestId("team-page")).toBeVisible();
}

/** The member table row of a person (member, invited or requested). */
export const member = (p: Page, email: string) => p.locator(`[data-member="${email}"]`);

export async function invite(
  p: Page,
  emails: string[],
  opts: { message?: string; admin?: boolean } = {},
): Promise<void> {
  await openTeam(p);
  const form = p.getByTestId("invite-form");
  if (!(await form.isVisible()))
    await p.getByRole("button", { name: /^(Add member|Invite)$/ }).click();
  await form.getByLabel(/^Emails/).fill(emails.join(", "));
  if (opts.message) await form.getByLabel(/^Message/).fill(opts.message);
  if (opts.admin) await form.getByLabel("Make admin").check();
  await form.getByRole("button", { name: "Send invitations" }).click();
  await expect(p.getByTestId("invite-result")).toBeVisible();
}

export const joinLink = (text: string): string => {
  const m = /https?:\/\/\S+\/join\/[A-Za-z0-9_-]+/.exec(text);
  if (!m) throw new Error(`no join link in: ${text}`);
  return m[0];
};

/** Opens a join link and accepts it, for a person who is already signed in. */
export async function accept(p: Page, link: string): Promise<void> {
  await p.goto(link);
  await p.getByRole("button", { name: "Join team" }).click();
  await expect(p.getByTestId("team-page")).toBeVisible();
}

export async function setTeamSettings(
  p: Page,
  s: { name?: string; joinMode?: string; invitePermission?: string },
): Promise<void> {
  await openTeam(p);
  const form = p.getByTestId("team-settings");
  if (s.name) await form.getByLabel("Team name").fill(s.name);
  if (s.joinMode) await form.getByLabel("How people join").selectOption({ label: s.joinMode });
  if (s.invitePermission)
    await form.getByLabel("Who can invite").selectOption({ label: s.invitePermission });
  await form.getByRole("button", { name: "Save team settings" }).click();
  await expect(form.getByTestId("team-settings-saved")).toBeVisible();
}

/** Two users in one team: the signed-in page's user (admin) and `b`. Returns b's page. */
export async function teamOfTwo(
  page: Page,
  signIn: () => Promise<void>,
  b: { signIn: () => Promise<Page>; email: string },
  mail: { message(to: string, s: RegExp): Promise<{ text: string }> },
): Promise<Page> {
  const pb = await b.signIn();
  await signIn();
  await invite(page, [b.email]);
  await accept(pb, joinLink((await mail.message(b.email, /invited you/)).text));
  await page.reload();
  await expect(member(page, b.email)).toContainText("active");
  return pb;
}
