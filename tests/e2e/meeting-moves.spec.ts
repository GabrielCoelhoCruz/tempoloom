// Flexible meeting moves and their reporting
// (docs/specs/meetings-flexible-rescheduling.md, meetings-flexible.md setup,
// planning-notifications.md NTF-20 to NTF-22 and NTF-30).
//
// Ways it can fail, and the test that catches each:
// - a required guest's decline does not move the occurrence, or it moves
//   back onto the declined time                                     -> decline
// - an optional guest's decline moves it                            -> decline
// - a move, a decline or an applied suggestion leaves no change-log
//   entry, or the entry has the wrong reason, times or actor        -> decline, limit
// - guests get no update email for a move inside the days-ahead limit,
//   or get one for a move beyond it or while the setting is off     -> decline
// - the move limit is not counted, so a second conflict in a day moves
//   the meeting again, or a meeting with "no automatic moves" moves  -> limit
// - a flagged occurrence shows no suggested times, or applying one does
//   not move and lock it                                            -> limit
// - the series list shows a series the user only attends, or misses the
//   user's own; the form is not filled from the series              -> adopt
// - attaching rules creates new events instead of keeping the series,
//   or moves an instance that has no conflict                       -> adopt
// - a conflict moves the wrong instance, or the move creates a new event
//   outside the series                                              -> adopt
// - the at-risk email misses a meeting kept in conflict; the new
//   recurring meeting email misses a series or its link does not open
//   the form filled from it                                         -> daily emails
// - settings are lost after a reload                                -> decline, daily emails
import { addDays } from "../../src/shared/time.ts";
import {
  at,
  BACKEND,
  blockUntil,
  type CalendarDriver,
  EMAIL,
  eventually,
  expect,
  local,
  test,
} from "./fixtures.ts";
import { titled, W } from "./helpers.ts";
import { allDayBusy } from "./ics.ts";
import {
  addMeeting,
  answerAs,
  dailyMail,
  meetingEmails,
  putMeeting,
  rawEvent,
  soon,
} from "./meeting-helpers.ts";

test.skip(BACKEND === "google", "Meeting move E2E uses two CalDAV users.");

const day = (n: number) => addDays(W, n);
const twoWeeks = (cal: CalendarDriver) => cal.events(at(W, "00:00"), at(day(14), "00:00"));
const starts = (evs: Awaited<ReturnType<typeof twoWeeks>>, title: string) =>
  titled(evs, title).map((e) => `${local(e.start)}-${local(e.end).slice(11)}`);
const LONG = { timeout: 60_000 };

test("a required guest's decline moves the occurrence and an optional guest's does not; each move is logged; guests get an update email only inside the days-ahead limit and while emails are on (MEET-02 rules 2, 31-32, 36; NTF-20 to NTF-22)", async ({
  page,
  cal,
  signIn,
  colleague,
  mail,
}) => {
  await blockUntil(cal, W);
  await blockUntil(colleague.cal, W);
  await colleague.signIn();
  await signIn();
  // This week's Tuesday is inside the limit; next week's is beyond it.
  const daysAhead = Math.ceil((at(day(1), "10:00") - Date.now()) / 86_400_000);
  await meetingEmails(page, { guests: true, daysAhead });
  await addMeeting(page, { title: "Sync", guests: colleague.email, optional: "opt@example.com" });
  await eventually(
    () => twoWeeks(cal),
    (l) => expect(starts(l, "Sync")).toEqual([`${day(1)} 10:00-10:30`, `${day(8)} 10:00-10:30`]),
  );

  // Beyond the limit: a conflict next week moves that occurrence without an email.
  await colleague.cal.addEvent({
    title: "Workshop",
    start: at(day(8), "09:00"),
    end: at(day(8), "11:00"),
  });
  const placed = await eventually(
    () => twoWeeks(cal),
    (l) => expect(starts(l, "Sync")).toEqual([`${day(1)} 10:00-10:30`, `${day(8)} 11:00-11:30`]),
  );

  // The optional guest declines this week's occurrence: nothing changes.
  const first = titled(placed, "Sync")[0];
  if (!first) throw new Error("no occurrence");
  await answerAs(cal.calendarId, first.id, "opt@example.com", "DECLINED");

  // With emails off, a conflict moves this week's occurrence silently.
  await meetingEmails(page, { guests: false });
  await colleague.cal.addEvent({
    title: "Call",
    start: at(day(1), "10:00"),
    end: at(day(1), "10:30"),
  });
  const moved = await eventually(
    () => twoWeeks(cal),
    (l) => expect(starts(l, "Sync")).toEqual([`${day(1)} 09:30-10:00`, `${day(8)} 11:00-11:30`]),
  );

  // With emails on, the colleague declines the new time: it moves again,
  // never back onto the declined time, and the guests hear of it.
  await meetingEmails(page, { guests: true });
  const near = titled(moved, "Sync")[0];
  if (!near) throw new Error("no occurrence");
  await answerAs(cal.calendarId, near.id, colleague.email, "DECLINED");
  await eventually(
    () => twoWeeks(cal),
    (l) => expect(starts(l, "Sync")).toEqual([`${day(1)} 10:30-11:00`, `${day(8)} 11:00-11:30`]),
  );
  const update = await mail.message(colleague.email, /Updated: Sync/);
  expect(update.text).toContain(`${day(1)} 09:30`);
  expect(update.text).toContain(`${day(1)} 10:30`);
  await mail.message("opt@example.com", /Updated: Sync/);
  // Only that one: the move beyond the limit and the move with emails off sent none.
  expect(await mail.count(colleague.email)).toBe(1);
  expect(await mail.count("opt@example.com")).toBe(1);

  await page.getByRole("link", { name: "Meetings" }).click();
  const log = page.locator('[data-meeting-title="Sync"]').getByTestId("change");
  await expect(log).toHaveCount(3);
  await expect(log.and(page.locator('[data-reason="declined"]'))).toContainText(
    `${day(1)} 09:30 → ${day(1)} 10:30`,
  );
  await expect(log.and(page.locator('[data-reason="declined"]'))).toContainText(colleague.email);
  await expect(log.and(page.locator('[data-reason="conflict"]'))).toHaveCount(2);
  await expect(log.filter({ hasText: `${day(8)} 10:00 → ${day(8)} 11:00` })).toHaveCount(1);
  await expect(log.filter({ hasText: `${day(1)} 10:00 → ${day(1)} 09:30` })).toHaveCount(1);
  await expect(log.filter({ hasText: "opt@example.com" })).toHaveCount(0);

  await page.reload();
  await expect(log).toHaveCount(3);
  await page.getByRole("link", { name: "Settings" }).click();
  const form = page.getByTestId("meeting-emails");
  await expect(
    form.getByLabel("Email guests when Tempoloom moves or cancels a meeting"),
  ).toBeChecked();
  await expect(form.getByLabel("Only for meetings in the next (days)")).toHaveValue(
    String(daysAhead),
  );
});

test("the move limit: with 1 move per day a second conflict is flagged with suggested times and a suggestion applies as a locked move; with no automatic moves the meeting stays and is flagged (MEET-02 rules 9-11, 17)", async ({
  page,
  cal,
  signIn,
  colleague,
}) => {
  await blockUntil(cal, W);
  await blockUntil(colleague.cal, W);
  await colleague.signIn();
  await signIn();
  await addMeeting(page, { title: "Sync", guests: colleague.email, moves: "1 per day" });
  await addMeeting(page, {
    title: "Retro",
    guests: colleague.email,
    days: ["Wed"],
    moves: "No automatic moves",
  });
  await eventually(
    () => twoWeeks(cal),
    (l) => {
      expect(starts(l, "Sync")).toEqual([`${day(1)} 10:00-10:30`, `${day(8)} 10:00-10:30`]);
      expect(starts(l, "Retro")).toEqual([`${day(2)} 10:00-10:30`, `${day(9)} 10:00-10:30`]);
    },
  );

  // The first conflict uses the one move of the day.
  await colleague.cal.addEvent({
    title: "Call",
    start: at(day(1), "10:00"),
    end: at(day(1), "10:30"),
  });
  await eventually(
    () => twoWeeks(cal),
    (l) => expect(starts(l, "Sync")[0]).toBe(`${day(1)} 09:30-10:00`),
  );
  // The second conflict that day is flagged; the occurrence stays.
  await colleague.cal.addEvent({
    title: "Interview",
    start: at(day(1), "09:00"),
    end: at(day(1), "10:00"),
  });
  await colleague.cal.addEvent({
    title: "Offsite",
    start: at(day(2), "10:00"),
    end: at(day(2), "11:00"),
  });
  await eventually(
    () => twoWeeks(cal),
    (l) => {
      const sync = titled(l, "Sync")[0];
      expect([sync?.summary, local(sync?.start ?? 0)]).toEqual(["⚠️ Sync", `${day(1)} 09:30`]);
      const retro = titled(l, "Retro")[0];
      expect([retro?.summary, local(retro?.start ?? 0)]).toEqual(["⚠️ Retro", `${day(2)} 10:00`]);
    },
  );

  await page.getByRole("link", { name: "Meetings" }).click();
  const sync = page.locator('[data-meeting-title="Sync"]');
  const retro = page.locator('[data-meeting-title="Retro"]');
  await expect(sync.getByTestId("meeting-flag")).toContainText("Move limit reached", LONG);
  await expect(retro.getByTestId("meeting-flag")).toContainText("No automatic moves", LONG);
  await expect(retro.getByTestId("suggestion").first()).toBeVisible();
  const suggestions = sync.getByTestId("suggestion");
  await expect(suggestions).toHaveCount(3);
  await expect(suggestions.first()).toHaveText(`Move to ${day(1)} 10:30`);
  await suggestions.first().click();
  await eventually(
    () => twoWeeks(cal),
    (l) => {
      const s = titled(l, "Sync")[0];
      expect([s?.summary, local(s?.start ?? 0), s?.busy]).toEqual([
        "🔒 Sync",
        `${day(1)} 10:30`,
        true,
      ]);
    },
  );

  await page.reload();
  await expect(sync.getByTestId("meeting-flag")).toHaveCount(0, LONG);
  await expect(sync.getByTestId("meeting-occurrences")).toContainText("locked");
  await expect(retro.getByTestId("meeting-flag")).toContainText("No automatic moves");
  const log = sync.getByTestId("change");
  await expect(log.and(page.locator('[data-reason="conflict"]'))).toContainText(
    `${day(1)} 10:00 → ${day(1)} 09:30`,
  );
  await expect(log.and(page.locator('[data-reason="manualMove"]'))).toContainText(
    `${day(1)} 09:30 → ${day(1)} 10:30`,
  );
  // Retro never moved.
  expect(starts(await twoWeeks(cal), "Retro")[0]).toBe(`${day(2)} 10:00-10:30`);
});

test("meeting rules attach to an existing recurring meeting the user organizes: the form is filled from it, the series keeps its id and gets tl_meeting, and Tempoloom moves its instances around a conflict (MEET-01 rules 1, 3, 39)", async ({
  page,
  cal,
  signIn,
  colleague,
}) => {
  await blockUntil(cal, W);
  await blockUntil(colleague.cal, W);
  await colleague.signIn();
  const series = await putMeeting(cal.calendarId, {
    title: "Sync A-B",
    start: at(day(1), "10:00"),
    end: at(day(1), "10:30"),
    organizer: EMAIL,
    attendees: [{ email: colleague.email, answer: "ACCEPTED" }],
    description: "Weekly notes",
    rrule: "FREQ=WEEKLY;COUNT=6",
  });
  await putMeeting(cal.calendarId, {
    title: "Their standup",
    start: at(day(2), "09:00"),
    end: at(day(2), "09:15"),
    organizer: "boss@example.com",
    attendees: [{ email: EMAIL, answer: "ACCEPTED" }],
    rrule: "FREQ=WEEKLY;COUNT=6",
  });
  await signIn();

  await page.getByRole("link", { name: "Meetings" }).click();
  const form = page.getByTestId("meeting-form");
  const pick = form.getByLabel("From an existing meeting");
  await expect(pick.locator("option", { hasText: "Sync A-B" })).toHaveCount(1, LONG);
  await expect(pick.locator("option", { hasText: "Their standup" })).toHaveCount(0);
  await pick.selectOption({ label: "Sync A-B" });
  await expect(form.getByLabel("Title")).toHaveValue("Sync A-B");
  await expect(form.getByLabel("Guests (comma list)", { exact: true })).toHaveValue(
    colleague.email,
  );
  await expect(form.getByLabel("Ideal time")).toHaveValue("10:00");
  await expect(form.getByLabel("Duration (minutes)")).toHaveValue("30");
  await expect(form.getByLabel("Tue", { exact: true })).toBeChecked();
  await expect(form.getByLabel("Wed", { exact: true })).not.toBeChecked();
  await expect(form.getByLabel("Description")).toHaveValue("Weekly notes");
  await form.getByRole("button", { name: "Add meeting" }).click();
  await expect(page.locator('[data-meeting-title="Sync A-B"]')).toBeVisible();

  // The instances stay at their time and stay instances of the one series,
  // which now carries the meeting's id.
  const instances = (l: Awaited<ReturnType<typeof twoWeeks>>) =>
    l.filter((e) => e.summary.includes("Sync A-B"));
  await eventually(
    () => twoWeeks(cal),
    (l) => {
      expect(starts(l, "Sync A-B")).toEqual([`${day(1)} 10:00-10:30`, `${day(8)} 10:00-10:30`]);
      expect(instances(l).every((e) => e.recurringId === series)).toBe(true);
      expect(instances(l).every((e) => (e.privateProps.tl_meeting ?? "") !== "")).toBe(true);
    },
  );
  expect(await rawEvent(cal.calendarId, series)).toContain("RRULE:FREQ=WEEKLY;COUNT=6");

  // A conflict for the guest moves this week's instance only, inside the series.
  await colleague.cal.addEvent({
    title: "Workshop",
    start: at(day(1), "09:00"),
    end: at(day(1), "11:00"),
  });
  const after = await eventually(
    () => twoWeeks(cal),
    (l) =>
      expect(starts(l, "Sync A-B")).toEqual([`${day(1)} 11:00-11:30`, `${day(8)} 10:00-10:30`]),
  );
  expect(instances(after)).toHaveLength(2);
  expect(instances(after).every((e) => e.id.startsWith(`${series}#`))).toBe(true);

  await page.reload();
  const p2 = page.locator("section", { hasText: "P2 high" });
  await expect(p2.locator('[data-meeting-title="Sync A-B"]')).toBeVisible();
  await expect(
    page.locator('[data-meeting-title="Sync A-B"]').getByTestId("meeting-occurrences"),
  ).toContainText("11:00");
  expect(starts(await twoWeeks(cal), "Sync A-B")).toEqual([
    `${day(1)} 11:00-11:30`,
    `${day(8)} 10:00-10:30`,
  ]);
});

test("the daily emails list meetings at risk in the next 14 days and new recurring meetings that could become flexible; the email's link opens the form filled from that series (MEET-02 rule 35; NTF-30)", async ({
  page,
  cal,
  signIn,
  mail,
}) => {
  await blockUntil(cal, W);
  for (const d of [0, 1, 2, 3, 4]) await allDayBusy(cal.calendarId, "Conference", day(d));
  await putMeeting(cal.calendarId, {
    title: "Team sync",
    start: at(day(3), "15:00"),
    end: at(day(3), "15:30"),
    organizer: EMAIL,
    attendees: [{ email: "ben@example.com", answer: "ACCEPTED" }],
    rrule: "FREQ=WEEKLY;COUNT=8",
  });
  await signIn();
  await addMeeting(page, { title: "Crunch", guests: "dana@example.com" });
  // No time this week: the occurrence is kept as a marked conflict.
  await eventually(
    () => twoWeeks(cal),
    (l) => {
      const crunch = titled(l, "Crunch");
      expect(crunch.map((e) => e.summary.startsWith("⚠️"))).toEqual([true, false]);
      expect(local(crunch[0]?.start ?? 0)).toBe(`${day(1)} 10:00`);
    },
  );

  const time = soon();
  await meetingEmails(page, { atRisk: true, newSeries: true, time });
  const risk = await dailyMail(mail, EMAIL, /Meetings at risk/);
  expect(risk.text).toContain("Crunch");
  expect(risk.text).toContain(day(1));
  const offer = await mail.message(EMAIL, /Recurring meetings you could make flexible/);
  expect(offer.text).toContain("Team sync");
  expect(offer.text).not.toContain("Crunch");
  const link = /https?:\/\/\S+\/meetings\?adopt=\S+/.exec(offer.text)?.[0];
  if (!link) throw new Error(`no link in: ${offer.text}`);

  await page.goto(link);
  const form = page.getByTestId("meeting-form");
  await expect(form.getByLabel("Title")).toHaveValue("Team sync", LONG);
  await expect(form.getByLabel("Guests (comma list)", { exact: true })).toHaveValue(
    "ben@example.com",
  );
  await expect(form.getByLabel("Thu", { exact: true })).toBeChecked();
  await expect(form.getByLabel("Ideal time")).toHaveValue("15:00");

  await page.reload();
  await page.getByRole("link", { name: "Settings" }).click();
  const emails = page.getByTestId("meeting-emails");
  await expect(emails.getByLabel("Send daily emails at")).toHaveValue(time);
  await expect(emails.getByLabel("Daily email about meetings at risk")).toBeChecked();
  await expect(emails.getByLabel("Email me about new recurring meetings")).toBeChecked();
});
