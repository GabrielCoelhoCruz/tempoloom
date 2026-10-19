// Team stats (docs/specs/analytics-team-stats.md; figures as in
// analytics-personal-stats.md; meeting types from events-categories-and-colors.md).
// Several Radicale users form one team; each calendar holds known events.
//
// Ways it can fail, and the check that catches each:
// - the team tab is missing, or a reload drops the tab or the range       -> tab, URL and values after reload
// - figures are sums, or one member's values, not means over members     -> exact averages (T1)
// - a member's name, email or event title shows in the team view          -> page text has none of them
// - a provisioned member without a calendar is averaged in as zero        -> same averages and the counts (T3)
// - a team with fewer than 3 included members shows values                -> not-enough-members message (T4)
// - the time-in-meetings panel counts hours, not members, or uses other
//   thresholds; the daily panel uses calendar days, not workdays          -> percent per threshold, week and day (T2)
// - opening team stats changes a calendar                                 -> events before = events after
// - a future range leaves out planned time (tasks, recovery buffers)      -> next-week figures (rule 7)
// - one time zone sets every member's day boundaries and work hours       -> the New York member's late call
//                                                                             counts on their Monday, outside work
// - travel time and break time are missing                                -> travel and breaks averages
// - a range typed right after the page opens is overwritten by the page's
//   first load (it runs after the first paint, late in a background tab)  -> future week, typed in a background tab
import { addDays, localToUtc } from "../../src/shared/time.ts";
import {
  CLIENT,
  directory,
  lastWeek,
  meet,
  openStats,
  snapshot,
  synced,
} from "./analytics-helpers.ts";
import { at, BACKEND, blockUntil, EMAIL, eventually, expect, test } from "./fixtures.ts";
import { addTask, allEvents, titled, W } from "./helpers.ts";

test.skip(BACKEND === "google", "Team stats E2E uses several CalDAV users.");

test("team stats show averages over the included members of last week, with no names, a time-in-meetings distribution, and no values for small teams (team stats rules 1-6, 8, 9; T1-T4)", async ({
  page,
  app,
  cal,
  signIn,
  colleague,
  people,
}) => {
  const P = lastWeek();
  const day = (n: number) => addDays(P, n);
  const c = await people(3);
  const B = colleague.email;
  const C = c.email;
  // A: team meeting, 3 h one-on-one with B, 6 h external, one 3 h solo event: 10 h of meetings.
  await meet(cal, day(0), "10:00", "11:00", "Team planning", [B, C]);
  await meet(cal, day(1), "10:00", "13:00", "Pairing", [B]);
  await meet(cal, day(2), "09:00", "12:00", "Client workshop", [CLIENT]);
  await meet(cal, day(3), "09:00", "12:00", "Client review", [CLIENT]);
  await meet(cal, day(4), "09:00", "12:00", "Write report");
  // B: the team meeting and the one-on-one: 4 h. C: the team meeting: 1 h.
  await meet(colleague.cal, day(0), "10:00", "11:00", "Team planning", [EMAIL, C]);
  await meet(colleague.cal, day(1), "10:00", "13:00", "Pairing", [EMAIL]);
  await meet(c.cal, day(0), "10:00", "11:00", "Team planning", [EMAIL, B]);

  await signIn();
  await colleague.signIn();
  const idp = await directory(page);
  await idp.create({ userName: EMAIL });
  await idp.create({ userName: B });

  // Two members: no values (T4).
  await openStats(page, "Team stats");
  await expect(page).toHaveURL(/\/stats\/team/);
  const stats = page.getByTestId("team-stats");
  await expect(stats).toContainText("Not enough members for team stats.");
  await page.reload();
  await expect(stats).toContainText("Not enough members for team stats.");

  // C joins; D is provisioned but has no calendar, so D is left out (T3).
  await c.signIn();
  await idp.create({ userName: C });
  await idp.create({ userName: "nocal@tempoloom.test" });
  await synced(app, [EMAIL, B, C]);
  const before = await snapshot(cal, at(P, "00:00"), at(day(7), "00:00"));

  await page.reload();
  await stats.getByRole("button", { name: "Last week" }).click();
  await stats.getByLabel("Group by").selectOption("week");
  await page.reload();
  await expect(stats.getByLabel("From")).toHaveValue(P);
  await expect(stats.getByTestId("included")).toHaveText(
    "3 members included · 1 without calendar data",
  );
  // T1: means over A, B and C.
  await expect(stats.getByTestId("avg-meetings")).toHaveText("5 h");
  await expect(stats.getByTestId("avg-oneOnOne")).toHaveText("2 h");
  await expect(stats.getByTestId("avg-teamMeetings")).toHaveText("1 h");
  await expect(stats.getByTestId("avg-externalMeetings")).toHaveText("2 h");
  await expect(stats.getByTestId("avg-deepWork")).toHaveText("1 h");
  await expect(stats.getByTestId("avg-shallowWork")).toHaveText("0 min");
  // Free work time: A 27 h, B 36 h, C 39 h.
  await expect(stats.getByTestId("avg-free")).toHaveText("34 h");
  // T2: meeting hours per week A 10, B 4, C 1.
  const dist = stats.getByTestId("time-in-meetings");
  const pct = (h: number) => dist.locator(`[data-threshold="${h}"]`);
  await expect(pct(0)).toHaveText("100%");
  await expect(pct(5)).toHaveText("33%");
  await expect(pct(10)).toHaveText("33%");
  await expect(pct(15)).toHaveText("0%");
  await expect(pct(30)).toHaveText("0%");
  // No member's name (all start with "e2e"), email or event title.
  const text = await stats.innerText();
  for (const leak of ["e2e", "colleague", "nocal", "Write report", "Pairing", "Client"])
    expect(text).not.toContain(leak);

  // Per workday: A 2 h, B 48 min, C 12 min.
  await stats.getByLabel("Group by").selectOption("day");
  await page.reload();
  await expect(pct(0)).toHaveText("100%");
  await expect(pct(1)).toHaveText("33%");
  await expect(pct(2)).toHaveText("33%");
  await expect(pct(3)).toHaveText("0%");

  // Rule 9: read-only.
  expect(await snapshot(cal, at(P, "00:00"), at(day(7), "00:00"))).toEqual(before);
});

test("team stats for a future week count planned tasks, recovery buffers and travel, with each member's days and work hours in their own time zone (rule 7; edge case 4)", async ({
  page,
  app,
  cal,
  signIn,
  colleague,
  people,
}) => {
  const c = await people(3);
  const B = colleague.email;
  const C = c.email;
  const NY = "America/New_York";
  await blockUntil(cal, W);
  const tue = addDays(W, 1);
  await meet(cal, tue, "10:00", "11:00", "Weekly sync", [B, C]);
  await meet(colleague.cal, tue, "10:00", "11:00", "Weekly sync", [EMAIL, C]);
  await meet(c.cal, tue, "10:00", "11:00", "Weekly sync", [EMAIL, B]);
  await meet(colleague.cal, addDays(W, 2), "08:00", "09:00", "Commute to the client");
  // 23:00 on Monday in New York is Tuesday in Berlin.
  await c.cal.addEvent({
    title: "Late call",
    start: localToUtc(NY, W, 23 * 60),
    end: localToUtc(NY, tue, 0),
    attendees: [CLIENT],
  });

  await signIn();
  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Add 15 min recovery after meetings" }).click();
  await addTask(page, { title: "AT-Plan", minutes: 120, split: false, due: "" });
  await colleague.signIn();
  const pc = await c.signIn();
  await pc.getByRole("link", { name: "Settings" }).click();
  await pc.getByLabel("Time zone").fill(NY);
  await pc.getByLabel("Time zone").press("Tab");
  await expect(pc.getByTestId("settings-message")).toHaveText("Saved");

  const idp = await directory(page);
  for (const email of [EMAIL, B, C]) await idp.create({ userName: email });
  await eventually(
    () => allEvents(cal),
    (l) => {
      expect(titled(l, "AT-Plan")).toHaveLength(1);
      expect(titled(l, "Recovery")).toHaveLength(1);
    },
  );
  await synced(app, [EMAIL, B, C]);

  // Another tab in front delays the page's first paint, as when a user switches tabs.
  const front = await page.context().newPage();
  await front.bringToFront();
  await openStats(page, "Team stats");
  const stats = page.getByTestId("team-stats");
  await stats.getByLabel("From").fill(W);
  await stats.getByLabel("To").fill(addDays(W, 6));
  await stats.getByLabel("Group by").selectOption("week");
  await page.reload();
  await expect(stats.getByTestId("avg-teamMeetings")).toHaveText("1 h");
  await expect(stats.getByTestId("avg-externalMeetings")).toHaveText("20 min");
  await expect(stats.getByTestId("avg-deepWork")).toHaveText("40 min");
  await expect(stats.getByTestId("avg-tasks")).toHaveText("40 min");
  await expect(stats.getByTestId("avg-breaks")).toHaveText("5 min");
  await expect(stats.getByTestId("avg-travel")).toHaveText("20 min");
  // C's two meetings fall outside 09:00-17:00 New York time.
  await expect(stats.getByTestId("avg-outsideWork")).toHaveText("40 min");
  // Free work time: A 36 h 45 min, B 39 h, C 40 h.
  await expect(stats.getByTestId("avg-free")).toHaveText("38 h 35 min");

  // By day: the late call counts on C's own Monday.
  await stats.getByLabel("Group by").selectOption("day");
  await page.reload();
  const bar = (date: string) =>
    stats.locator(`[data-date="${date}"] [data-cat="externalMeetings"]`);
  await expect(bar(W)).toHaveAttribute("title", "External meetings: 20 min");
  await expect(bar(tue)).toHaveCount(0);
  await expect(stats.getByTestId("heaviest-day")).toHaveText("Tuesday");
});
