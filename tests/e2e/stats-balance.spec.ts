// The work-life balance and highlights panels of personal stats
// (docs/specs/analytics-personal-stats.md rules 5 and 8).
//
// Ways this can fail, each covered below:
// - personal habits, late meetings or time away miss the balance panel, or work
//   habits and meetings inside work hours count there;
// - focus time held, link bookings, breaks or travel buffers miss the highlights;
// - the panels lose the chosen range on reload.
import { addDays } from "../../src/shared/time.ts";
import { at, BACKEND, blockUntil, eventually, expect, test } from "./fixtures.ts";
import { addHabit, book, claimPage, MIN, titled, visitor, W } from "./helpers.ts";
import { outOfOffice } from "./ics.ts";

const day = (n: number) => addDays(W, n);
const hm = (m: number) => {
  const h = Math.floor(m / 60);
  const r = m % 60;
  return h && r ? `${h} h ${r} min` : h ? `${h} h` : `${r} min`;
};

test("stats show work-life balance (personal habits, meetings outside work hours, time away) and highlights (focus held, link bookings, breaks, travel) for a chosen range", async ({
  page,
  browser,
  cal,
  signIn,
}) => {
  test.skip(BACKEND === "google", "Meetings with attendees and out-of-office need CalDAV here.");
  await blockUntil(cal, W);
  await cal.addEvent({
    title: "Team sync",
    start: at(day(1), "10:00"),
    end: at(day(1), "11:00"),
    attendees: ["ana@tempoloom.test"],
  });
  await cal.addEvent({
    title: "Late call",
    start: at(day(1), "19:00"),
    end: at(day(1), "19:45"),
    attendees: ["sam@example.com"],
  });
  await cal.addEvent({
    title: "Site visit",
    start: at(day(3), "14:00"),
    end: at(day(3), "15:00"),
    location: "Hauptstrasse 1, 10115 Berlin, Germany",
  });
  await outOfOffice(cal.calendarId, "Vacation", { from: day(4), to: day(5) });
  await signIn();

  // Personal and work habits: only the personal one is work-life balance.
  await addHabit(page, {
    title: "Evening run",
    ideal: "18:00",
    min: 60,
    max: 60,
    days: ["Mon", "Wed"],
    hours: "Personal hours",
  });
  await page.reload();
  await addHabit(page, { title: "Inbox", ideal: "16:00", min: 30, max: 30, days: ["Tue"] });
  // Focus time with a 3-hour goal, a recovery buffer and travel time.
  await page.getByTestId("create-menu").locator("summary").click();
  await page
    .getByTestId("create-menu")
    .getByRole("link", { name: "Focus time", exact: true })
    .click();
  const form = page.getByTestId("automation-form");
  await form.getByLabel("Title").fill("Deep focus");
  await form.getByLabel("Weekly goal (hours)").fill("3");
  await form.getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("automations-page")).toBeVisible();
  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Add 15 min recovery after meetings" }).click();
  await expect(page.getByTestId("buffer-list")).toContainText("Recovery");
  await page.getByRole("button", { name: "Add travel time (30 min)" }).click();
  await expect(page.getByTestId("buffer-list")).toContainText("Travel");
  // A visitor books 30 minutes through a booking link.
  await claimPage(page, "balance");
  const v = await visitor(browser);
  await v.goto("/book/balance/quick-meeting");
  await book(v, at(day(2), "11:00"), "Bo", "bo@example.com");

  const placed = await eventually(
    () => cal.events(at(W, "00:00"), at(day(7), "00:00")),
    (l) => {
      expect(titled(l, "Evening run")).toHaveLength(2);
      expect(titled(l, "Inbox")).toHaveLength(1);
      // The 30-minute work habit counts toward the 3-hour goal (focus-time.md rule 2).
      expect(titled(l, "Deep focus").reduce((a, e) => a + (e.end - e.start) / MIN, 0)).toBe(150);
      expect(titled(l, "Travel")).toHaveLength(2);
      expect(titled(l, "Recovery").length).toBeGreaterThanOrEqual(2);
    },
  );
  const recovery = titled(placed, "Recovery").reduce((a, e) => a + (e.end - e.start) / MIN, 0);

  await page.getByRole("link", { name: "Stats" }).click();
  await page.getByLabel("From").fill(W);
  await page.getByLabel("To").fill(day(6));
  const check = async () => {
    const balance = page.getByTestId("work-life-balance");
    await expect(balance.getByTestId("wl-personal-habits")).toHaveText("2 h");
    await expect(balance.getByTestId("hl-outside")).toHaveText("45 min");
    // Friday's out-of-office day is one workday of time away.
    await expect(balance.getByTestId("wl-time-away")).toHaveText("8 h");
    const highlights = page.getByTestId("highlights");
    await expect(highlights.getByTestId("hl-focus")).toHaveText("2 h 30 min");
    await expect(highlights.getByTestId("hl-bookings")).toHaveText("1");
    await expect(highlights.getByTestId("hl-breaks")).toHaveText(hm(recovery));
    await expect(highlights.getByTestId("hl-travel")).toHaveText("1 h");
  };
  await check();
  await page.reload();
  await expect(page.getByLabel("From")).toHaveValue(W);
  await check();
});
