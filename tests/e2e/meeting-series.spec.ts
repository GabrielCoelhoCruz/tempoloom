// A flexible meeting made from the form is one recurring series on its
// calendar (docs/specs/meetings-flexible.md rule 2), and the organizer's
// series edits in the calendar are kept (meetings-flexible-rescheduling.md
// rules 18 and 22).
//
// Ways it can fail, and the test that catches each:
// - each occurrence is its own calendar event, or a move writes a new event
//   instead of an override (RECURRENCE-ID) of the series            -> series
// - "this and following" splits the series: the occurrences of the new
//   series count as deleted (skipped) or resized by hand (locked), or the
//   occurrences before the split take the new length too            -> following
// - "all events" changes the master: each occurrence counts as resized by
//   hand and locks, or the occurrences that Tempoloom moved keep the old
//   length                                                           -> all
// - a series edit of day, time, title or guests locks every occurrence,
//   is written back, or leaves the meeting rules as they were; privacy and
//   free/busy edits on the series are kept instead of written back; a guest
//   the organizer removed from one occurrence comes back              -> edits

import type { Page } from "@playwright/test";
import { addDays } from "../../src/shared/time.ts";
import { fillEventSettings } from "./automation-list-helpers.ts";
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
} from "./fixtures.ts";
import { openWeek, titled, W } from "./helpers.ts";
import {
  addMeeting,
  blockProp,
  editInstance,
  editMaster,
  instanceRaw,
  masterOf,
  overrideOf,
  rawObject,
  splitSeries,
  vevents,
} from "./meeting-helpers.ts";

test.skip(BACKEND === "google", "Series E2E reads and writes raw iCalendar objects on CalDAV.");

const day = (n: number) => addDays(W, n);
const twoWeeks = (cal: CalendarDriver) => cal.events(at(W, "00:00"), at(day(14), "00:00"));
const compact = (d: string) => d.replace(/-/g, "");
const times = (l: Awaited<ReturnType<typeof twoWeeks>>, title: string) =>
  titled(l, title).map((e) => `${local(e.start)}-${local(e.end).slice(11)}`);
/** The calendar objects (series or single events) that hold `title`. */
const objects = (l: Awaited<ReturnType<typeof twoWeeks>>, title: string) =>
  new Set(titled(l, title).map((e) => e.id.split("#")[0]));

const row = (page: Page, title: string) => page.locator(`[data-meeting-title="${title}"]`);

/** The meeting's first occurrences in the Meetings page, after a reload. */
async function expectShown(page: Page, title: string, expected: RegExp[]) {
  await page.reload();
  await page.getByRole("link", { name: "Meetings" }).click();
  const items = row(page, title).getByTestId("meeting-occurrences").locator("li");
  // In this order, after any occurrence of the current week (the plan may hold one there).
  const inOrder = new RegExp(expected.map((r) => r.source.replace(/\$$/, "")).join("\\|.*"));
  await expect.poll(async () => (await items.allTextContents()).join("|")).toMatch(inOrder);
}

test("a meeting from the form is one recurring series on the calendar: one event with a weekly rule, and a moved occurrence is an override of it (MEET-01 rule 2)", async ({
  page,
  cal,
  signIn,
  app,
}) => {
  await blockUntil(cal, W);
  // Next week's Tuesday 9:00 to 11:00 is busy: that occurrence moves to 11:00.
  await cal.addEvent({ title: "Board call", start: at(day(8), "09:00"), end: at(day(8), "11:00") });
  await signIn();
  await addMeeting(page, { title: "Series sync", guests: "dana@example.com", days: ["Tue"] });

  const list = await eventually(
    () => twoWeeks(cal),
    (l) =>
      expect(times(l, "Series sync")).toEqual([`${day(1)} 10:00-10:30`, `${day(8)} 11:00-11:30`]),
    60_000,
  );
  const [first, second] = titled(list, "Series sync");
  if (!first || !second) throw new Error("two occurrences");
  // Both are instances of one series: one calendar object.
  expect(first.recurringId).not.toBeNull();
  expect(second.recurringId).toBe(first.recurringId);
  expect(objects(list, "Series sync").size).toBe(1);

  const series = async () => {
    const ics = await rawObject(cal.calendarId, first.id);
    const master = masterOf(ics);
    return {
      // Overrides from the test week on (an earlier, ended one may carry the done marker).
      overrides: vevents(ics).filter(
        (b) => (blockProp(b, "RECURRENCE-ID") ?? "") >= `${compact(W)}T`,
      ).length,
      rule: blockProp(master, "RRULE"),
      // The rule time of the first period the plan placed: a Tuesday at 10:00, local.
      start: /^DTSTART;TZID=Europe\/Berlin:\d{8}T100000$/m.test(master),
      guest: master.toLowerCase().includes("mailto:dana@example.com"),
      // Next week's instance: its rule time stays its id; the override holds the new time.
      moved: blockProp(overrideOf(ics, second.id) ?? "", "DTSTART"),
      firstOwn: overrideOf(ics, first.id) !== null,
    };
  };
  const expected = {
    overrides: 1,
    rule: "FREQ=WEEKLY;BYDAY=TU",
    start: true,
    guest: true,
    moved: `${compact(day(8))}T100000Z`,
    firstOwn: false,
  };
  expect(await series()).toEqual(expected);
  expect(second.id).toContain(`#${day(8)}T10:00:00`);

  // Reload, more plan runs and a server restart keep one series, unchanged.
  await expectShown(page, "Series sync", [/10:00 to 10:30$/, /11:00 to 11:30$/]);
  await app.restart();
  await page.reload();
  await planNow(page);
  await planNow(page);
  expect(await series()).toEqual(expected);
  const after = await twoWeeks(cal);
  expect(times(after, "Series sync")).toEqual([`${day(1)} 10:00-10:30`, `${day(8)} 11:00-11:30`]);
  expect(objects(after, "Series sync").size).toBe(1);
});

/** Adds a weekly Tuesday meeting of `minutes` with one guest, then waits for both weeks. */
async function weekly(page: Page, cal: CalendarDriver, title: string, minutes: number) {
  await addMeeting(page, { title, guests: "dana@example.com", days: ["Tue"], duration: minutes });
  const end = (h: number, m: number) =>
    `${String(h + Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  const list = await eventually(
    () => twoWeeks(cal),
    (l) =>
      expect(times(l, title)).toEqual([
        `${day(1)} 10:00-${end(10, minutes)}`,
        `${day(8)} 10:00-${end(10, minutes)}`,
      ]),
    60_000,
  );
  return titled(list, title) as [(typeof list)[0], (typeof list)[0]];
}

test("a calendar resize of this and the following occurrences sets the meeting length from that occurrence on; the earlier occurrence keeps its length and nothing locks (MEET-02 rule 18)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  const [, second] = await weekly(page, cal, "Plan review", 60);

  // The organizer shortens next week's occurrence and the following ones to 45 minutes
  // (not the form default, so a reset to it shows).
  const added = await splitSeries(cal.calendarId, second, (lines) =>
    lines.map((l) => (/^DTEND[:;]/.test(l) ? l.replace(/T\d{6}/, "T104500") : l)),
  );
  const expected = [`${day(1)} 10:00-11:00`, `${day(8)} 10:00-10:45`];
  await eventually(
    async () => {
      await planNow(page);
      return twoWeeks(cal);
    },
    (l) => expect(times(l, "Plan review")).toEqual(expected),
    60_000,
  );
  await expect(row(page, "Plan review")).toContainText("45 min");
  await expectShown(page, "Plan review", [/10:00 to 11:00$/, /10:00 to 10:45$/]);
  await expect(row(page, "Plan review")).toContainText("every week, ideally Tue at 10:00 · 45 min");
  // Kept, not counted as a skip or a move by hand: nothing is locked.
  await expect(row(page, "Plan review").getByTestId("meeting-occurrences")).not.toContainText(
    "locked",
  );
  await expect(row(page, "Plan review").locator('[data-reason="manualSkip"]')).toHaveCount(0);
  await expect(row(page, "Plan review").locator('[data-reason="manualMove"]')).toHaveCount(0);

  // The calendar holds the ended series and the new one; later runs change nothing.
  await planNow(page);
  await planNow(page);
  const after = await twoWeeks(cal);
  expect(times(after, "Plan review")).toEqual(expected);
  expect([...objects(after, "Plan review")].sort()).toHaveLength(2);
  expect(titled(after, "Plan review")[1]?.id.split("#")[0]).toBe(added);
  expect(blockProp(masterOf(await rawObject(cal.calendarId, added)), "DTEND")).toContain("T104500");
});

test("a calendar resize of all occurrences sets the meeting length for every occurrence, also the one Tempoloom moved, and nothing locks (MEET-02 rule 18)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  // Next week's Tuesday 9:00 to 10:30 is busy: that occurrence moves to 10:30 (an override).
  await cal.addEvent({ title: "Stand-up", start: at(day(8), "09:00"), end: at(day(8), "10:30") });
  await signIn();
  await addMeeting(page, { title: "Team sync", guests: "dana@example.com", days: ["Tue"] });
  const list = await eventually(
    () => twoWeeks(cal),
    (l) =>
      expect(times(l, "Team sync")).toEqual([`${day(1)} 10:00-10:30`, `${day(8)} 10:30-11:00`]),
    60_000,
  );
  const [first] = titled(list, "Team sync");
  if (!first) throw new Error("occurrence");

  // The organizer makes the whole series 45 minutes long.
  await editMaster(cal.calendarId, first.id, (lines) =>
    lines.map((l) => (/^DTEND[:;]/.test(l) ? l.replace(/T\d{6}/, "T104500") : l)),
  );
  const expected = [`${day(1)} 10:00-10:45`, `${day(8)} 10:30-11:15`];
  await eventually(
    async () => {
      await planNow(page);
      return twoWeeks(cal);
    },
    (l) => expect(times(l, "Team sync")).toEqual(expected),
    60_000,
  );
  await expect(row(page, "Team sync")).toContainText("ideally Tue at 10:00 · 45 min");
  await expectShown(page, "Team sync", [/10:00 to 10:45$/, /10:30 to 11:15$/]);
  await expect(row(page, "Team sync").getByTestId("meeting-occurrences")).not.toContainText(
    "locked",
  );
  await expect(row(page, "Team sync").locator('[data-reason="manualMove"]')).toHaveCount(0);
  await planNow(page);
  const after = await twoWeeks(cal);
  expect(times(after, "Team sync")).toEqual(expected);
  expect(objects(after, "Team sync").size).toBe(1);
});

test("series edits in the calendar are kept: a new day and time set the meeting's ideal day and time, a new title and guest list reach the meeting, nothing locks, and privacy and free/busy are written back; a guest the organizer removes from one occurrence stays removed (MEET-02 rule 22)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await addMeeting(page, {
    title: "Review",
    guests: "dana@example.com",
    days: ["Tue"],
    more: async (form) => {
      await form.getByLabel("Show as").selectOption({ label: "Always busy" });
      await fillEventSettings(form, { visibility: "Private" });
    },
  });
  const list = await eventually(
    () => twoWeeks(cal),
    (l) => expect(times(l, "Review")).toEqual([`${day(1)} 10:00-10:30`, `${day(8)} 10:00-10:30`]),
    60_000,
  );
  const [first] = titled(list, "Review");
  if (!first) throw new Error("occurrence");

  // "All events": Thursday 14:00, a new title, Erin instead of Dana, public and free.
  await editMaster(cal.calendarId, first.id, (lines) =>
    lines.flatMap((l) => {
      if (/^DTSTART[:;]/.test(l)) return [l.replace(/:\d{8}T\d{6}/, `:${compact(day(3))}T140000`)];
      if (/^DTEND[:;]/.test(l)) return [l.replace(/:\d{8}T\d{6}/, `:${compact(day(3))}T143000`)];
      if (l.startsWith("RRULE:")) return [l.replace("BYDAY=TU", "BYDAY=TH")];
      if (l.startsWith("SUMMARY:")) return [`${l} board`];
      if (/^(CLASS|TRANSP)[:;]/.test(l)) return [];
      if (/^ATTENDEE.*mailto:dana@example.com$/i.test(l))
        return ["ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:erin@example.com"];
      if (l === "END:VEVENT") return ["CLASS:PUBLIC", "TRANSP:TRANSPARENT", l];
      return [l];
    }),
  );
  const expected = [`${day(3)} 14:00-14:30`, `${day(10)} 14:00-14:30`];
  const moved = await eventually(
    async () => {
      await planNow(page);
      return twoWeeks(cal);
    },
    (l) => expect(times(l, "Review board")).toEqual(expected),
    60_000,
  );
  // Privacy and free/busy are Tempoloom's: each occurrence is private and busy again.
  for (const e of titled(moved, "Review board"))
    await eventually(
      async () => instanceRaw(cal.calendarId, e.id),
      (b) => expect([blockProp(b, "CLASS"), blockProp(b, "TRANSP")]).toEqual(["PRIVATE", "OPAQUE"]),
      60_000,
    );
  const meeting = row(page, "Review board");
  await page.reload();
  await page.getByRole("link", { name: "Meetings" }).click();
  await expect(meeting).toContainText("every week, ideally Thu at 14:00 · 30 min");
  await expect(meeting.getByTestId("meeting-attendees")).toContainText("erin@example.com");
  await expect(meeting.getByTestId("meeting-attendees")).not.toContainText("dana@example.com");
  await expect(meeting.getByTestId("meeting-occurrences")).not.toContainText("locked");
  await expect(meeting.locator('[data-reason="manualMove"]')).toHaveCount(0);
  await expect(meeting.locator('[data-reason="manualSkip"]')).toHaveCount(0);

  // "This event": the organizer removes Erin from this week's occurrence only.
  const [thisWeek, nextWeek] = titled(moved, "Review board");
  if (!thisWeek || !nextWeek) throw new Error("two occurrences");
  await editInstance(cal.calendarId, thisWeek, (lines) =>
    lines.filter((l) => !/mailto:erin@example.com$/i.test(l)),
  );
  const erin = async (id: string) =>
    (await instanceRaw(cal.calendarId, id)).toLowerCase().includes("mailto:erin@example.com");
  await planNow(page);
  await planNow(page);
  expect([await erin(thisWeek.id), await erin(nextWeek.id)]).toEqual([false, true]);
  // A lock writes Tempoloom's fields only: Erin stays removed.
  await openWeek(page);
  await page.locator(".ev-meeting", { hasText: "Review board" }).first().click();
  await page.getByTestId("event-drawer").getByRole("button", { name: "Lock" }).click();
  await eventually(
    async () => instanceRaw(cal.calendarId, thisWeek.id),
    (b) => expect(blockProp(b, "SUMMARY")).toContain("🔒"),
    60_000,
  );
  expect([await erin(thisWeek.id), await erin(nextWeek.id)]).toEqual([false, true]);
  const final = await twoWeeks(cal);
  expect(times(final, "Review board")).toEqual(expected);
  expect(objects(final, "Review board").size).toBe(1);
});
