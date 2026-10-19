// The weekly report email and its calendar facts
// (docs/specs/analytics-weekly-reports.md rules 1-7, T1, T3).
//
// Ways this can fail, each covered below:
// - the report goes out before the first hour of work on the last workday, or twice a week;
// - the facts of the email differ from the facts the stats page shows for the week;
// - a fact with a zero value shows, or more than 4 facts show;
// - the report is off for a new user, or the opt-out is lost on reload or ignored.
import type { Page } from "@playwright/test";
import { addDays, localToUtc } from "../../src/shared/time.ts";
import { at, BACKEND, blockUntil, eventually, expect, test, ZONE } from "./fixtures.ts";
import { MIN, titled, W } from "./helpers.ts";

const day = (n: number) => addDays(W, n);
const iso = (date: string, hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  return new Date(localToUtc(ZONE, date, h * 60 + m)).toISOString();
};
const hm = (m: number) => {
  const h = Math.floor(m / 60);
  const r = m % 60;
  return h && r ? `${h} h ${r} min` : h ? `${h} h` : `${r} min`;
};

async function reportSwitch(page: Page) {
  await page.getByRole("link", { name: "Settings" }).click();
  return page.getByTestId("weekly-report").getByLabel("Weekly report email");
}

test("the weekly report goes out once in the first work hour of the last workday, with the week's totals and the calendar facts of the stats page; the user can turn it off", async ({
  page,
  cal,
  app,
  mail,
  signIn,
}) => {
  test.skip(BACKEND === "google", "Meetings with attendees need CalDAV here.");
  await blockUntil(cal, W);
  const team = ["ana@tempoloom.test", "ben@tempoloom.test"];
  await cal.addEvent({
    title: "Planning",
    start: at(day(1), "10:00"),
    end: at(day(1), "11:30"),
    attendees: team,
  });
  await cal.addEvent({
    title: "1:1 with Vera",
    start: at(day(1), "14:00"),
    end: at(day(1), "14:30"),
    attendees: ["vera@tempoloom.test"],
  });
  await cal.addEvent({
    title: "Sync",
    start: at(day(3), "10:00"),
    end: at(day(3), "10:30"),
    attendees: team,
  });
  await cal.addEvent({ title: "Write spec", start: at(day(2), "09:00"), end: at(day(2), "11:30") });
  await signIn();
  // On for a new user.
  await expect(await reportSwitch(page)).toBeChecked();
  await page.getByRole("button", { name: "Add 15 min recovery after meetings" }).click();
  await expect(page.getByTestId("buffer-list")).toContainText("Recovery");
  const placed = await eventually(
    () => cal.events(at(W, "00:00"), at(day(5), "00:00")),
    (l) => expect(titled(l, "Recovery")).toHaveLength(3),
  );
  const breaks = titled(placed, "Recovery").reduce((a, e) => a + (e.end - e.start) / MIN, 0);
  const facts = [
    "Busiest meeting day: Tuesday (2 h)",
    "Longest focus session: 2 h 30 min",
    `Breaks taken: ${hm(breaks)}`,
    "People met: 3",
  ];
  // The stats page shows the same facts for the week.
  await page.getByRole("link", { name: "Stats" }).click();
  await page.getByLabel("From").fill(W);
  await page.getByLabel("To").fill(day(4));
  const shown = page.getByTestId("calendar-facts");
  for (const f of facts) await expect(shown).toContainText(f);

  // Work hours end the week on Friday, 09:00 to 17:00: nothing before 09:00.
  expect(app.cli("weekly-reports", "--now", iso(day(4), "08:55"))).toContain("sent 0 reports");
  expect(app.cli("weekly-reports", "--now", iso(day(3), "09:30"))).toContain("sent 0 reports");
  expect(app.cli("weekly-reports", "--now", iso(day(4), "09:30"))).toContain("sent 1 report");
  expect(app.cli("weekly-reports", "--now", iso(day(4), "09:45"))).toContain("sent 0 reports");
  const report = await mail.message("e2e@tempoloom.test", /Your week/);
  expect(report.subject).toBe(`Your week: ${W} to ${day(4)}`);
  expect(report.text).toContain("Meetings: 2 h 30 min");
  expect(report.text).toContain("Solo work: 2 h 30 min");
  expect(report.text).toContain("Personal time: 0 min");
  const listed = report.text
    .split("\n")
    .filter((l) => l.startsWith("- "))
    .map((l) => l.slice(2));
  expect(listed).toEqual(facts);
  expect(report.html).toContain("Longest focus session: 2 h 30 min");
  expect(report.text).toContain(`/stats?from=${W}&to=${day(4)}`);
  expect(await mail.count("e2e@tempoloom.test")).toBe(1);

  // Opt out: the switch stays off after reload, and next Friday sends nothing.
  await (await reportSwitch(page)).uncheck();
  await expect(page.getByTestId("weekly-report-saved")).toHaveText("Saved");
  await page.reload();
  await expect(
    page.getByTestId("weekly-report").getByLabel("Weekly report email"),
  ).not.toBeChecked();
  expect(app.cli("weekly-reports", "--now", iso(day(11), "09:30"))).toContain("sent 0 reports");
  expect(await mail.count("e2e@tempoloom.test")).toBe(1);
});
