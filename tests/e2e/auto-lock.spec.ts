// The auto-lock schedule per item kind (docs/specs/planning-locks.md
// LCK-30 to LCK-33). The server clock is set (TEST_CLOCK_START), so the
// lock hour of the days before and in the test week can come inside the test.
// The week starts on Sunday (the calendar setting of LCK-33; CalDAV has no
// such setting, so the test sets it through the settings API).
//
// Ways it can fail, and the check that catches each:
// - the run locks before 01:00                                 -> Sunday 00:30: all open
// - "week" counts from Monday, not the user's week start, or
//   locks the next week too                                    -> habits at Sunday 01:30
// - "week" runs again on another day of the week              -> late habit stays open
// - "day" locks the whole week, or nothing (flexible meetings
//   by their default, focus time by choice)                    -> meeting, focus on Tuesday
// - "off" still locks                                          -> task
// - an event placed after the run is locked too, or turning the
//   setting off and on does not lock the current week at once  -> late habit
// - the choices are lost after a reload                        -> settings
// - an ended event loses its lock                              -> Monday habit in the planner
import { localToUtc } from "../../src/shared/time.ts";
import { day, openSettings, span } from "./automation-helpers.ts";
import {
  at,
  BACKEND,
  blockUntil,
  type CalendarDriver,
  eventually,
  expect,
  local,
  planNow,
  test,
  ZONE,
} from "./fixtures.ts";
import { addHabit, addTask, titled, W } from "./helpers.ts";
import { addMeeting } from "./meeting-helpers.ts";

const LOCK = "🔒";
const DONE = "✅";
const SUNDAY = day(-1);
const twoWeeks = (cal: CalendarDriver) => cal.events(at(W, "00:00"), at(day(14), "00:00"));
type Evs = Awaited<ReturnType<typeof twoWeeks>>;
const iso = (date: string, hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  return new Date(localToUtc(ZONE, date, h * 60 + m)).toISOString();
};
const isLocked = (e: Evs[number]) => e.summary.startsWith(LOCK) && e.busy;
/** "locked" or "open" per event, with its time. */
const states = (l: Evs, title: string, from: number, to: number) =>
  titled(l, title)
    .filter((e) => e.start >= from && e.start < to)
    .map((e) => `${span(e)} ${isLocked(e) ? "locked" : "open"}`);
/** Focus time per day: "locked", "open" or "mixed". */
const focusDays = (l: Evs) => {
  const out: Record<string, string> = {};
  for (const e of titled(l, "Focus time")) {
    const d = local(e.start).slice(0, 10);
    const s = isLocked(e) ? "locked" : "open";
    out[d] = out[d] === undefined || out[d] === s ? s : "mixed";
  }
  return out;
};

test("auto-lock per kind: from 01:00 a Sunday-start week locks habits, each day locks meetings by default and focus time, off locks nothing; later events wait until the setting is turned off and on (LCK-30 to LCK-33)", async ({
  page,
  app,
  cal,
  signIn,
}) => {
  test.skip(BACKEND === "google", "Moves the server clock (CalDAV only).");
  test.setTimeout(300_000);
  await blockUntil(cal, W);
  await signIn();
  // LCK-33: the week starts on Sunday.
  const weekStart = await page.evaluate(() =>
    fetch("/api/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ weekStart: 7 }),
    }).then((r) => r.status),
  );
  expect(weekStart).toBe(200);
  await openSettings(page);
  const form = page.getByTestId("auto-lock");
  // Defaults: flexible meetings each day, the other kinds off.
  await expect(form.getByLabel("Flexible meetings")).toHaveValue("day");
  for (const kind of ["Habits", "Tasks", "Focus time"])
    await expect(form.getByLabel(kind)).toHaveValue("off");
  const choose = async (kind: string, value: "off" | "day" | "week") => {
    const saved = page.waitForResponse(
      (r) => r.request().method() === "PATCH" && new URL(r.url()).pathname === "/api/settings",
    );
    await form.getByLabel(kind).selectOption(value);
    expect((await saved).ok()).toBe(true);
    await expect(form.getByLabel(kind)).toHaveValue(value);
  };
  await choose("Habits", "week");
  await choose("Focus time", "day");
  await page.getByRole("button", { name: "Protect 10 hours of focus time per week" }).click();

  await addHabit(page, { title: "AT-L4", ideal: "12:00", min: 30, max: 30 });
  await addTask(page, { title: "AT-L6", minutes: 60, split: false, due: "" });
  await addMeeting(page, {
    title: "AT-L7",
    guests: "dana@example.com",
    idealTime: "15:00",
    days: ["Tue"],
  });
  const weekdays = [0, 1, 2, 3, 4];
  /** From `since` (a weekday index), so a later check can leave out the events that ended. */
  const habits =
    (first: "open" | "locked", since = 0) =>
    (l: Evs) =>
      expect(states(l, "AT-L4", at(day(since), "00:00"), at(day(14), "00:00"))).toEqual([
        ...weekdays.filter((d) => d >= since).map((d) => `${day(d)} 12:00-12:30 ${first}`),
        ...weekdays.map((d) => `${day(d + 7)} 12:00-12:30 open`),
      ]);
  const task = (l: Evs) =>
    expect(titled(l, "AT-L6").map((e) => `${local(e.start).slice(0, 10)} ${isLocked(e)}`)).toEqual([
      `${W} false`,
    ]);
  const meetings = (first: "open" | "locked") => (l: Evs) =>
    expect(states(l, "AT-L7", at(W, "00:00"), at(day(14), "00:00"))).toEqual([
      `${day(1)} 15:00-15:30 ${first}`,
      `${day(8)} 15:00-15:30 open`,
    ]);
  const focus = (tuesday: "open" | "locked") => (l: Evs) => {
    const days = focusDays(l);
    expect(days[day(1)]).toBe(tuesday);
    const rest = Object.entries(days).filter(([d]) => d !== day(1));
    expect(rest.length).toBeGreaterThan(0);
    for (const [, s] of rest) expect(s).toBe("open");
  };
  const placed = (l: Evs) => {
    habits("open")(l);
    task(l);
    meetings("open")(l);
  };
  await eventually(() => twoWeeks(cal), placed, 60_000);

  // Sunday before the test week, 00:30: the lock hour has not come. The focus
  // goal's week is now the test week, so focus time is placed there.
  app.env.TEST_CLOCK_START = iso(SUNDAY, "00:30");
  await app.restart();
  await page.reload();
  const allOpen = (l: Evs) => {
    placed(l);
    focus("open")(l);
  };
  await eventually(() => twoWeeks(cal), allOpen, 60_000);
  await planNow(page);
  await planNow(page);
  allOpen(await twoWeeks(cal));

  // Sunday 01:30: the first day of the week, so habits lock Monday to Friday of
  // this week. Meetings and focus time lock Sunday only, which has none.
  app.env.TEST_CLOCK_START = iso(SUNDAY, "01:30");
  await app.restart();
  await eventually(
    () => twoWeeks(cal),
    (l) => {
      habits("locked")(l);
      task(l);
      meetings("open")(l);
      focus("open")(l);
    },
    60_000,
  );

  // Tuesday 01:30: each day locks Tuesday's meeting and focus time; the habit
  // week ran already, so it does not run again. Monday's habit has ended: in the
  // calendar the done marker takes the place of the lock marker (title marker
  // rule 2), in the same run that locks Tuesday, so the check waits for the done
  // marker. The lock itself stays: the planner still shows Monday's habit locked.
  app.env.TEST_CLOCK_START = iso(day(1), "01:30");
  await app.restart();
  const tuesday = (l: Evs) => {
    expect(
      titled(l, "AT-L4")
        .filter((e) => local(e.start).slice(0, 10) === day(0))
        .map((e) => `${span(e)} ${e.summary} ${e.busy ? "busy" : "free"}`),
    ).toEqual([`${day(0)} 12:00-12:30 ${DONE} AT-L4 busy`]);
    habits("locked", 1)(l);
    task(l);
    meetings("locked")(l);
    focus("locked")(l);
  };
  await eventually(() => twoWeeks(cal), tuesday, 60_000);
  const mondayInPlanner = () =>
    page.evaluate(
      ([from, to]) =>
        fetch(`/api/planner/events?from=${from}&to=${to}`)
          .then((r) => r.json() as Promise<{ events: { title: string; locked: boolean }[] }>)
          .then((b) => b.events.filter((e) => e.title === "AT-L4").map((e) => e.locked)),
      [at(day(0), "00:00"), at(day(1), "00:00")] as const,
    );
  await expect.poll(mondayInPlanner).toEqual([true]);

  // A habit made after the run is not locked, until habits go off and on again.
  await page.reload();
  await addHabit(page, { title: "AT-L5", ideal: "14:00", min: 30, max: 30 });
  const fresh = (state: "open" | "locked") => (l: Evs) =>
    expect(states(l, "AT-L5", at(W, "00:00"), at(day(14), "00:00"))).toEqual([
      ...[1, 2, 3, 4].map((d) => `${day(d)} 14:00-14:30 ${state}`),
      ...weekdays.map((d) => `${day(d + 7)} 14:00-14:30 open`),
    ]);
  await eventually(() => twoWeeks(cal), fresh("open"));
  // Two more full sync rounds: still not locked.
  await planNow(page);
  await planNow(page);
  fresh("open")(await twoWeeks(cal));
  await openSettings(page);
  await choose("Habits", "off");
  await choose("Habits", "week");
  await eventually(() => twoWeeks(cal), fresh("locked"));
  // The other kinds keep their locks (Monday has ended, so it is left out).
  const after = await twoWeeks(cal);
  habits("locked", 1)(after);
  task(after);
  meetings("locked")(after);
  focus("locked")(after);

  await page.reload();
  await openSettings(page);
  await expect(form.getByLabel("Habits")).toHaveValue("week");
  await expect(form.getByLabel("Tasks")).toHaveValue("off");
  await expect(form.getByLabel("Flexible meetings")).toHaveValue("day");
  await expect(form.getByLabel("Focus time")).toHaveValue("day");
});
