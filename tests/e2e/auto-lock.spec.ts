// The auto-lock schedule per item kind (docs/specs/planning-locks.md
// LCK-30 to LCK-33). The server clock is set (TEST_CLOCK_START), so the
// first day of the test week can begin inside the test.
//
// Ways it can fail, and the check that catches each:
// - "week" locks only one day, or locks the next week too          -> habit events
// - "day" locks the whole week, or nothing                          -> task chunks
// - "off" still locks (flexible meetings default to "day")          -> meeting
// - an event placed after the lock run is locked too, or turning the
//   setting off and on does not lock the current week at once       -> second habit
// - the choices are lost after a reload                             -> settings
import { localToUtc } from "../../src/shared/time.ts";
import { day, openSettings, span } from "./automation-helpers.ts";
import {
  at,
  BACKEND,
  blockUntil,
  type CalendarDriver,
  eventually,
  expect,
  test,
  ZONE,
} from "./fixtures.ts";
import { addHabit, addTask, titled, W } from "./helpers.ts";
import { addMeeting } from "./meeting-helpers.ts";

const LOCK = "🔒";
const twoWeeks = (cal: CalendarDriver) => cal.events(at(W, "00:00"), at(day(14), "00:00"));
type Evs = Awaited<ReturnType<typeof twoWeeks>>;
const iso = (date: string, hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  return new Date(localToUtc(ZONE, date, h * 60 + m)).toISOString();
};
/** "locked" or "open" per event, with its time. */
const states = (l: Evs, title: string, from: number, to: number) =>
  titled(l, title)
    .filter((e) => e.start >= from && e.start < to)
    .map((e) => `${span(e)} ${e.summary.startsWith(LOCK) && e.busy ? "locked" : "open"}`);

test("auto-lock per kind: week locks the current week, day locks today, off locks nothing; later events wait until the setting is turned off and on (LCK-30 to LCK-32)", async ({
  page,
  app,
  cal,
  signIn,
}) => {
  test.skip(BACKEND === "google", "Moves the server clock (CalDAV only).");
  await blockUntil(cal, W);
  await signIn();
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
  await choose("Tasks", "day");
  await choose("Flexible meetings", "off");

  await addHabit(page, { title: "AT-L4", ideal: "12:00", min: 30, max: 30 });
  await addTask(page, { title: "AT-L6 mon", minutes: 60, split: false, due: "" });
  await addTask(page, {
    title: "AT-L6 tue",
    minutes: 60,
    split: false,
    due: "",
    startAfter: `${day(1)}T09:00`,
  });
  await addMeeting(page, {
    title: "AT-L7",
    guests: "dana@example.com",
    idealTime: "15:00",
    days: ["Mon"],
  });
  const weekdays = [0, 1, 2, 3, 4];
  await eventually(
    () => twoWeeks(cal),
    (l) => {
      expect(states(l, "AT-L4", at(W, "00:00"), at(day(14), "00:00"))).toEqual(
        [...weekdays, ...weekdays.map((d) => d + 7)].map((d) => `${day(d)} 12:00-12:30 open`),
      );
      expect(states(l, "AT-L6", at(W, "00:00"), at(day(7), "00:00"))).toEqual([
        `${W} 09:00-10:00 open`,
        `${day(1)} 09:00-10:00 open`,
      ]);
      expect(states(l, "AT-L7", at(W, "00:00"), at(day(1), "00:00"))).toEqual([
        `${W} 15:00-15:30 open`,
      ]);
    },
  );

  // Monday of the test week, 01:30: the lock run has its hour.
  app.env.TEST_CLOCK_START = iso(W, "01:30");
  await app.restart();
  const locked = (l: Evs) => {
    expect(states(l, "AT-L4", at(W, "00:00"), at(day(14), "00:00"))).toEqual([
      ...weekdays.map((d) => `${day(d)} 12:00-12:30 locked`),
      ...weekdays.map((d) => `${day(d + 7)} 12:00-12:30 open`),
    ]);
    expect(states(l, "AT-L6", at(W, "00:00"), at(day(7), "00:00"))).toEqual([
      `${W} 09:00-10:00 locked`,
      `${day(1)} 09:00-10:00 open`,
    ]);
    expect(states(l, "AT-L7", at(W, "00:00"), at(day(1), "00:00"))).toEqual([
      `${W} 15:00-15:30 open`,
    ]);
  };
  await eventually(() => twoWeeks(cal), locked, 60_000);

  // A habit made after the run is not locked, until habits go off and on again.
  await page.reload();
  await addHabit(page, { title: "AT-L5", ideal: "14:00", min: 30, max: 30 });
  const fresh = (state: "open" | "locked") => (l: Evs) =>
    expect(states(l, "AT-L5", at(W, "00:00"), at(day(14), "00:00"))).toEqual([
      ...weekdays.map((d) => `${day(d)} 14:00-14:30 ${state}`),
      ...weekdays.map((d) => `${day(d + 7)} 14:00-14:30 open`),
    ]);
  await eventually(() => twoWeeks(cal), fresh("open"));
  // Two more sync rounds: still not locked.
  await page.waitForTimeout(11_000);
  fresh("open")(await twoWeeks(cal));
  await openSettings(page);
  await choose("Habits", "off");
  await choose("Habits", "week");
  await eventually(() => twoWeeks(cal), fresh("locked"));
  locked(await twoWeeks(cal));

  await page.reload();
  await openSettings(page);
  await expect(form.getByLabel("Habits")).toHaveValue("week");
  await expect(form.getByLabel("Tasks")).toHaveValue("day");
  await expect(form.getByLabel("Flexible meetings")).toHaveValue("off");
  await expect(form.getByLabel("Focus time")).toHaveValue("off");
});
