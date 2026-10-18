// Shared steps for team and organization analytics scenarios.
import type { Page } from "@playwright/test";
import { addDays, utcToLocal, weekdayOf } from "../../src/shared/time.ts";
import { type AppServer, at, type CalendarDriver, eventually, expect, ZONE } from "./fixtures.ts";
import { scim } from "./scim.ts";
import { openTeam } from "./team-helpers.ts";

/** Monday of last week, in the test zone. */
export function lastWeek(now = Date.now()): string {
  const today = utcToLocal(ZONE, now).date;
  return addDays(today, 1 - weekdayOf(today) - 7);
}

/** Today in the test zone. */
export const today = () => utcToLocal(ZONE, Date.now()).date;

/** An event on `date` from `from` to `to` (local times); attendees make it a meeting. */
export const meet = (
  cal: CalendarDriver,
  date: string,
  from: string,
  to: string,
  title: string,
  attendees?: string[],
) =>
  cal.addEvent({
    title,
    start: at(date, from),
    end: at(date, to),
    ...(attendees ? { attendees } : {}),
  });

export const CLIENT = "client@example.com";

/** Creates the team's SCIM token on the team page and returns an identity provider client. */
export async function directory(page: Page) {
  await openTeam(page);
  const box = page.getByTestId("directory");
  await box.getByRole("button", { name: "Create SCIM token" }).click();
  await expect(box.getByTestId("scim-token")).not.toBeEmpty();
  return scim((await box.getByTestId("scim-token").textContent()) ?? "");
}

/** Waits until each user's calendars were read once, so the events written before sign-in are cached. */
export async function synced(app: AppServer, emails: string[]): Promise<void> {
  await eventually(
    async () =>
      app
        .query<{ email: string }>(
          `SELECT DISTINCT u.email FROM users u JOIN accounts a ON a.user_id = u.id
           JOIN calendars c ON c.account_id = a.id WHERE c.synced_at IS NOT NULL`,
        )
        .map((r) => r.email),
    (synced) => expect(synced).toEqual(expect.arrayContaining(emails)),
  );
}

/** Opens a tab of the stats page from the navigation. */
export async function openStats(
  p: Page,
  tab: "My stats" | "Team stats" | "Organization",
): Promise<void> {
  await p.getByRole("link", { name: "Stats", exact: true }).click();
  await p.getByTestId("stats-tabs").getByRole("link", { name: tab }).click();
}

/** Start and end of each event on a calendar in [from, to): proof that nothing changed. */
export const snapshot = async (cal: CalendarDriver, from: number, to: number) =>
  (await cal.events(from, to)).map((e) => `${e.id} ${e.start} ${e.end}`).sort();
