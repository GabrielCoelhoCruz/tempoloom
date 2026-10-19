// The meeting overload automation (docs/specs/focus-time.md rules 11-17, 23,
// AT 7; planning-next-up.md NXT-45; automations-library.md entries 8 and 26):
// daily and weekly meeting limits, the shortest block, hours, auto-decline,
// a task search, and the two library entries.
//
// Ways it can fail, and the check that catches each:
// - focus time appears before a limit is reached                   -> no events with one meeting hour
// - unanswered invitations or own events without guests count as meetings
//                                                                  -> the limit is reached only by accepted meetings
// - the protected time leaks outside the hours, overlaps meetings, or keeps
//   a gap shorter than the shortest block                         -> exact spans
// - other days get focus time from a daily limit                   -> only Tuesday
// - the protected time is free, so others can book over it         -> busy
// - auto-decline misses the invitation in the protected time or sends no note
//                                                                  -> PARTSTAT and COMMENT
// - the focus time stays after meetings drop below the limit       -> events removed
// - the weekly limit protects days before it is reached, or not the rest of
//   the week                                                       -> days with events
// - a library entry does not fill the form, or the entry shows no badge
//                                                                  -> field values, "Added"
// - the recovery day caps every day, or the day of the heavy meetings itself
//                                                                  -> only the next workday
// - the task search of the automation does not show on its events  -> drawer list
// - settings are lost on reload                                    -> list row after reload

import {
  boxOf,
  day,
  invite,
  newTaskSearch,
  openLibrary,
  openSettings,
  rawEvent,
  span,
  week,
} from "./automation-helpers.ts";
import { at, BACKEND, blockUntil, eventually, expect, local, test } from "./fixtures.ts";
import { addTask, openWeek, titled, W } from "./helpers.ts";

test.skip(BACKEND === "google", "These scenarios use invitations and CalDAV reads.");

const guest = ["ana@example.com"];

test("a daily meeting limit turns the rest of that day into focus time, declines invitations there, and removes it when meetings drop (rules 11-15, 23; AT 7; NXT-45)", async ({
  page,
  app,
  cal,
  radicale,
  signIn,
}) => {
  if (!radicale) throw new Error("CalDAV only");
  await blockUntil(cal, W);
  const tue = day(1);
  await invite(cal, "Planning", tue, "09:00", "10:00", "ACCEPTED");
  // An own busy event without guests is not a meeting; it leaves a 15-minute gap before 17:00.
  await cal.addEvent({ title: "Errand", start: at(tue, "16:00"), end: at(tue, "16:45") });
  await signIn();
  await addTask(page, {
    title: "Write summary",
    minutes: 30,
    split: false,
    due: "",
    level: 4,
    startAfter: `${day(7)}T09:00`,
  });
  await openSettings(page);
  const form = page.getByTestId("overload-form");
  await form.getByLabel("Title").fill("Meeting cap");
  await form.getByLabel("Daily meeting limit (hours)").fill("2");
  await form.getByLabel("Shortest focus block (minutes)").fill("30");
  await form.getByLabel("Decline invitations that overlap the protected time").check();
  await form.getByLabel("Decline message").fill("Over my meeting limit today");
  await newTaskSearch(form, "Summaries", "summary");
  await form.getByRole("button", { name: "Add meeting overload" }).click();
  const row = page.locator('[data-overload-title="Meeting cap"]');
  await expect(row).toContainText("2 h a day");

  // One meeting hour and an unanswered invitation: no limit is reached.
  const late = await invite(cal, "Late sync", tue, "11:00", "12:00");
  await page.waitForTimeout(11_000);
  expect(titled(await week(cal), "Meeting cap")).toHaveLength(0);

  const review = await invite(cal, "Design review", tue, "10:00", "11:00", "ACCEPTED");
  const evs = await eventually(
    () => week(cal),
    (l) => expect(titled(l, "Meeting cap").map(span)).toEqual([`${tue} 11:00-16:00`]),
  );
  expect(titled(evs, "Meeting cap").every((e) => e.busy)).toBe(true);
  await eventually(
    () => week(cal),
    (l) => expect(l.find((e) => e.id === late)?.selfResponse).toBe("declined"),
  );
  expect(await rawEvent(radicale, late)).toContain("COMMENT:Over my meeting limit today");

  // The automation's task search shows on its events.
  const [protectedTime] = titled(evs, "Meeting cap");
  await openWeek(page);
  await (await boxOf(page, app, protectedTime?.id ?? "")).click();
  const search = page.getByTestId("event-task-search");
  await expect(search.getByLabel("Task search").locator("option:checked")).toHaveText("Summaries");
  await expect(search.getByTestId("search-tasks").locator("[data-task]")).toHaveText([
    "Write summary",
  ]);

  // Rule 15: below the limit again, the protected time goes; the decline stays.
  await cal.remove(review);
  await eventually(
    () => week(cal),
    (l) => expect(titled(l, "Meeting cap")).toHaveLength(0),
  );
  expect((await week(cal)).find((e) => e.id === late)?.selfResponse).toBe("declined");
  await openSettings(page);
  await page.reload();
  await expect(row).toContainText("2 h a day");
  await expect(row).toContainText("declines with “Over my meeting limit today”");
});

test("the meeting load cap entry fills the form; a weekly limit protects the rest of the week once reached (rule 13; library entry 26)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  // Meetings the user organizes, with a guest: Monday 3 hours, Tuesday 2 hours.
  await cal.addEvent({
    title: "Board prep",
    start: at(day(0), "09:00"),
    end: at(day(0), "12:00"),
    attendees: guest,
  });
  await cal.addEvent({
    title: "Hiring loop",
    start: at(day(1), "13:00"),
    end: at(day(1), "15:00"),
    attendees: guest,
  });
  await signIn();
  await openLibrary(page);
  const entry = page.locator('[data-entry="Meeting load cap"]');
  await expect(entry).not.toContainText("Needs a meeting load cap");
  await entry.getByRole("button", { name: "Use" }).click();
  const form = page.getByTestId("overload-form");
  await expect(form.getByLabel("Title")).toHaveValue("Meeting load cap");
  await expect(form.getByLabel("Daily meeting limit (hours)")).toHaveValue("5");
  await expect(form.getByLabel("Weekly meeting limit (hours)")).toHaveValue("20");
  // A lower weekly limit, so that this test week reaches it.
  await form.getByLabel("Daily meeting limit (hours)").fill("");
  await form.getByLabel("Weekly meeting limit (hours)").fill("5");
  await form.getByRole("button", { name: "Add meeting overload" }).click();
  await expect(page.locator('[data-overload-title="Meeting load cap"]')).toContainText(
    "5 h a week",
  );
  // The week reaches 5 meeting hours on Tuesday: Tuesday's free time and every later day.
  await eventually(
    () => week(cal),
    (l) =>
      expect(titled(l, "Meeting load cap").map(span)).toEqual([
        `${day(1)} 09:00-13:00`,
        `${day(1)} 15:00-17:00`,
        `${day(2)} 09:00-17:00`,
        `${day(3)} 09:00-17:00`,
        `${day(4)} 09:00-17:00`,
      ]),
  );
  await openLibrary(page);
  await expect(entry).toContainText("Added");
  await page.reload();
  await expect(entry).toContainText("Added");
});

test("the recovery day entry caps meetings only on the workday after a heavy meeting day (library entry 8)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  const meeting = (n: number, from: string, to: string) =>
    cal.addEvent({
      title: "Customer call",
      start: at(day(n), from),
      end: at(day(n), to),
      attendees: guest,
    });
  // Tuesday has 5 meeting hours; Wednesday and Thursday have 2 each.
  await meeting(1, "09:00", "12:00");
  await meeting(1, "13:00", "15:00");
  await meeting(2, "09:00", "11:00");
  await meeting(3, "09:00", "11:00");
  await signIn();
  await openLibrary(page);
  await page
    .locator('[data-entry="Recovery day after heavy meeting days"]')
    .getByRole("button", { name: "Use" })
    .click();
  const form = page.getByTestId("overload-form");
  await expect(form.getByLabel("Daily meeting limit (hours)")).toHaveValue("2");
  await expect(form.getByLabel("Only after a day with this many meeting hours")).toHaveValue("5");
  await form.getByRole("button", { name: "Add meeting overload" }).click();
  await expect(
    page.locator('[data-overload-title="Recovery day after heavy meeting days"]'),
  ).toContainText("after a day with 5 h");
  // Only Wednesday follows a heavy day and reaches 2 meeting hours.
  await eventually(
    () => week(cal),
    (l) =>
      expect(titled(l, "Recovery day after heavy meeting days").map(span)).toEqual([
        `${day(2)} 11:00-17:00`,
      ]),
  );
  await page.waitForTimeout(6000);
  expect(
    titled(await week(cal), "Recovery day after heavy meeting days").map((e) =>
      local(e.start).slice(0, 10),
    ),
  ).toEqual([day(2)]);
});
