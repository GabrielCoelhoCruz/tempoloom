// A custom holiday feed instead of built-in holidays
// (docs/specs/events-out-of-office.md rule 11; accounts-connected-calendars.md rule 5).
//
// Ways it can fail, and the test that catches each:
// - the feed URL is not accepted, or its calendar is not listed and connected
// - a feed day does not block work (feeds often mark holidays free)
// - a change in the feed is never read, so work stays away from the old day
// - the feed is gone after a reload; removing it leaves its calendar behind
// The test serves the feed from a small HTTP server on loopback.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { addDays } from "../../src/shared/time.ts";
import { calendarRow, openSettings } from "./calendar-helpers.ts";
import { BACKEND, blockUntil, eventually, expect, local, test } from "./fixtures.ts";
import { addTask, allEvents, titled, W } from "./helpers.ts";

test.skip(BACKEND === "google", "Uses the CalDAV backend for the main calendar.");

const feed = (holidays: { date: string; title: string }[]) =>
  [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//tempoloom-e2e//holidays//EN",
    "X-WR-CALNAME:Company holidays",
    ...holidays.flatMap((h) => [
      "BEGIN:VEVENT",
      `UID:${h.date}@holidays.test`,
      "DTSTAMP:20260101T000000Z",
      `DTSTART;VALUE=DATE:${h.date.replace(/-/g, "")}`,
      `DTEND;VALUE=DATE:${addDays(h.date, 1).replace(/-/g, "")}`,
      `SUMMARY:${h.title}`,
      "TRANSP:TRANSPARENT",
      "END:VEVENT",
    ]),
    "END:VCALENDAR",
    "",
  ].join("\r\n");

test("a holiday feed blocks its days; a change in the feed moves work; removing it removes its calendar (rule 11)", async ({
  page,
  cal,
  signIn,
}) => {
  let body = feed([{ date: W, title: "Founders Day" }]);
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/calendar; charset=utf-8" });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/holidays.ics`;
  try {
    await blockUntil(cal, W);
    await signIn();
    await openSettings(page);
    const form = page.getByTestId("holiday-feed-form");
    await expect(form).toContainText("Tempoloom does not read built-in public holiday calendars.");
    await form.getByLabel("Holiday feed URL").fill(url);
    await form.getByRole("button", { name: "Add holiday feed" }).click();
    await expect(page.getByTestId("calendars-message")).toHaveText("Holiday feed added.");
    const row = calendarRow(page, "Company holidays");
    await expect(row).toContainText("holiday feed");
    await expect(row.getByRole("checkbox")).toBeChecked();

    // The holiday on Monday blocks the day, although the feed marks it free.
    await addTask(page, { title: "AT-Holiday", minutes: 60, split: false, due: "" });
    await eventually(
      () => allEvents(cal),
      (l) => expect(local(titled(l, "AT-Holiday")[0]?.start ?? 0)).toBe(`${addDays(W, 1)} 09:00`),
    );

    // The feed moves the holiday to Tuesday; a refresh reads it, and the work moves back.
    body = feed([{ date: addDays(W, 1), title: "Founders Day" }]);
    await openSettings(page);
    await page.getByRole("button", { name: "Refresh calendar list" }).click();
    await eventually(
      () => allEvents(cal),
      (l) => expect(local(titled(l, "AT-Holiday")[0]?.start ?? 0)).toBe(`${W} 09:00`),
    );
    await page.reload();
    await expect(calendarRow(page, "Company holidays").getByRole("checkbox")).toBeChecked();

    // Remove the feed: its calendar is gone, also after a reload.
    await calendarRow(page, "Company holidays")
      .getByRole("button", { name: "Remove feed" })
      .click();
    await page.getByRole("dialog").getByRole("button", { name: "Remove feed" }).click();
    await expect(calendarRow(page, "Company holidays")).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId("calendar-list")).toContainText("Work");
    await expect(calendarRow(page, "Company holidays")).toHaveCount(0);
  } finally {
    server.close();
  }
});
