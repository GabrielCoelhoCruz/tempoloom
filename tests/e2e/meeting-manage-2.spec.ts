// Flexible meeting limits and manual actions, second part
// (docs/specs/meetings-flexible-rescheduling.md rules 7-8, 13, 17-18, 21-22,
// 28 and 33).
//
// Ways it can fail, and the test that catches each:
// - an automatic move ignores the move notice and takes a time sooner than
//   the notice, or the notice also holds a meeting with notice 0      -> notice
// - "remove" keeps an occurrence when there is no time, or "keep" drops
//   it; the meeting shows no reason; the next period is not placed    -> no time
// - the attention list misses a meeting's problem or lists a meeting
//   period that has none                                                   -> no time
// - delete leaves future occurrences, emails guests when told not to,
//   or does not email them when told to                              -> delete
// - lock from the planner does not lock a meeting occurrence, a locked
//   occurrence moves for a conflict, or unlock does not free it       -> manual
// - a resize in the calendar is put back or does not lock; a title edit
//   is put back; a free/busy edit is kept instead of written back      -> manual
import type { Page } from "@playwright/test";
import { addDays, weekdayOf } from "../../src/shared/time.ts";
import {
  at,
  BACKEND,
  blockUntil,
  type CalendarDriver,
  eventually,
  expect,
  local,
  test,
} from "./fixtures.ts";
import { openWeek, titled, W } from "./helpers.ts";
import { allDayBusy, credentials } from "./ics.ts";
import { addMeeting as fillMeeting, type MeetingForm } from "./meeting-helpers.ts";

test.skip(BACKEND === "google", "Meeting E2E writes raw iCalendar objects to CalDAV.");

const HOUR = 3_600_000;
const day = (n: number) => addDays(W, n);
const twoWeeks = (cal: CalendarDriver) => cal.events(at(W, "00:00"), at(day(14), "00:00"));
const starts = (evs: Awaited<ReturnType<typeof twoWeeks>>, title: string) =>
  titled(evs, title).map((e) => `${local(e.start)}-${local(e.end).slice(11)}`);
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"] as const;
const LONG = { timeout: 60_000 };

/** The meeting form with a move notice and a choice for periods with no time. */
async function addMeeting(
  page: Page,
  m: MeetingForm & { notice?: number; noTime?: "Remove it for that period" },
): Promise<void> {
  await page.getByRole("link", { name: "Meetings" }).click();
  const form = page.getByTestId("meeting-form");
  if (m.notice !== undefined) await form.getByLabel("Move notice (hours)").fill(String(m.notice));
  if (m.noTime) await form.getByLabel("When there is no time").selectOption({ label: m.noTime });
  await fillMeeting(page, m);
}

/** Replaces lines of a stored event, as another calendar app edits it. */
async function editRaw(calendarUrl: string, id: string, edit: (lines: string[]) => string[]) {
  const url = id.split("#")[0] ?? id;
  const auth = { authorization: credentials(calendarUrl) };
  const res = await fetch(url, { headers: auth });
  if (!res.ok) throw new Error(`GET ${url} failed: ${res.status}`);
  const etag = res.headers.get("etag");
  const lines = edit((await res.text()).replace(/\r?\n[ \t]/g, "").split(/\r?\n/));
  const put = await fetch(url, {
    method: "PUT",
    headers: { ...auth, "content-type": "text/calendar", ...(etag ? { "if-match": etag } : {}) },
    body: lines.join("\r\n"),
  });
  if (!put.ok) throw new Error(`PUT ${url} failed: ${put.status}`);
}

test("the move notice: an automatic move never starts sooner than the notice after the move, and a meeting with notice 0 takes the nearest time (MEET-02 rule 8)", async ({
  page,
  cal,
  signIn,
}) => {
  // A weekday 1 to 3 days ahead, so its 10:00 is less than 168 hours away.
  let d = addDays(local(Date.now()).slice(0, 10), 1);
  while (weekdayOf(d) > 5) d = addDays(d, 1);
  const weekday = DAYS[weekdayOf(d) - 1] as (typeof DAYS)[number];
  // The notice ends between 10:00 and 11:00 on that day.
  const notice = Math.ceil((at(d, "10:00") - Date.now()) / HOUR);
  const earliest = Date.now() + notice * HOUR;
  await signIn();
  await addMeeting(page, {
    title: "Notice sync",
    guests: "dana@example.com",
    days: [weekday],
    notice,
  });
  await addMeeting(page, {
    title: "Quick check",
    notice: 0,
    guests: "dana@example.com",
    days: [weekday],
    idealTime: "14:00",
  });
  const week = () => cal.events(Date.now(), at(addDays(d, 1), "00:00"));
  await eventually(week, (l) => {
    expect(starts(l, "Notice sync")).toEqual([`${d} 10:00-10:30`]);
    expect(starts(l, "Quick check")).toEqual([`${d} 14:00-14:30`]);
  });

  await cal.addEvent({ title: "Call", start: at(d, "10:00"), end: at(d, "10:30") });
  await cal.addEvent({ title: "Call", start: at(d, "14:00"), end: at(d, "14:30") });
  const moved = await eventually(week, (l) => {
    const [sync] = titled(l, "Notice sync");
    expect(sync && local(sync.start)).not.toBe(`${d} 10:00`);
    expect(starts(l, "Quick check")).toEqual([`${d} 13:30-14:00`]);
  });
  const [sync] = titled(moved, "Notice sync");
  if (!sync) throw new Error("no occurrence");
  // Without the notice the nearest time is 09:30 (as for Quick check, 13:30).
  expect(sync.start).toBeGreaterThanOrEqual(earliest);
  expect(sync.start).toBeGreaterThanOrEqual(at(d, "10:30"));
  expect(local(sync.start).slice(0, 10)).toBe(d);

  await page.getByRole("link", { name: "Meetings" }).click();
  const log = page.locator('[data-meeting-title="Notice sync"]').getByTestId("change");
  await expect(log.and(page.locator('[data-reason="conflict"]'))).toContainText(
    `${d} 10:00 → ${local(sync.start)}`,
    LONG,
  );
  await page.reload();
  await expect(log).toHaveCount(1);
  expect(titled(await week(), "Notice sync")[0]?.start).toBe(sync.start);
});

test("with no time in a period, 'remove' leaves the period empty and 'keep' keeps the occurrence at its time as a marked conflict; both say why in the meeting and in the attention list, and the next period is placed (MEET-02 rules 13, 33)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  for (const n of [0, 1, 2, 3, 4]) await allDayBusy(cal.calendarId, "Conference", day(n));
  await signIn();
  await addMeeting(page, {
    title: "Gone",
    guests: "dana@example.com",
    noTime: "Remove it for that period",
  });
  await addMeeting(page, { title: "Kept", guests: "dana@example.com", days: ["Wed"] });
  await eventually(
    () => twoWeeks(cal),
    (l) => {
      expect(starts(l, "Gone")).toEqual([`${day(8)} 10:00-10:30`]);
      expect(titled(l, "Kept").map((e) => `${e.summary} ${local(e.start)}`)).toEqual([
        `⚠️ Kept ${day(2)} 10:00`,
        `○ Kept ${day(9)} 10:00`,
      ]);
    },
  );
  const gone = page.locator('[data-meeting-title="Gone"]').getByTestId("meeting-occurrences");
  const kept = page.locator('[data-meeting-title="Kept"]').getByTestId("meeting-occurrences");
  const why = "busy all-day events fill the period";
  await expect(gone).toContainText(`Not placed: ${why}`, LONG);
  await expect(kept).toContainText(`Conflict: ${why}`, LONG);
  // One attention list for all meetings, with each problem of the week;
  // next week's placed occurrences are not in it.
  const items = page.getByTestId("meeting-attention").getByTestId("attention-item");
  const listed = async () => {
    await expect(items.filter({ hasText: `Gone · week of ${W} ·` })).toHaveText(
      `Gone · week of ${W} · Not placed: ${why}`,
    );
    await expect(items.filter({ hasText: `Kept · ${day(2)}` })).toHaveText(
      `Kept · ${day(2)} 10:00 · Conflict: ${why}`,
    );
    await expect(items.filter({ hasText: `week of ${day(7)}` })).toHaveCount(0);
    await expect(items.filter({ hasText: day(9) })).toHaveCount(0);
  };
  await listed();

  await page.reload();
  await listed();
  await expect(gone).toContainText(`Not placed: ${why}`);
  await expect(kept).toContainText(`Conflict: ${why}`);
  expect(starts(await twoWeeks(cal), "Gone")).toEqual([`${day(8)} 10:00-10:30`]);
});

test("manual actions: lock and unlock from the planner hold and free an occurrence; a resize in the calendar is kept and locks; a title edit is kept, a free/busy edit is written back (MEET-02 rules 7, 17-18, 21-22)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await addMeeting(page, { title: "Sync", guests: "dana@example.com" });
  await eventually(
    () => twoWeeks(cal),
    (l) => expect(starts(l, "Sync")).toEqual([`${day(1)} 10:00-10:30`, `${day(8)} 10:00-10:30`]),
  );

  // Lock from the planner: a clash does not move it.
  await openWeek(page);
  await page.locator(".ev-meeting", { hasText: "Sync" }).first().click();
  await page.getByTestId("event-drawer").getByRole("button", { name: "Lock" }).click();
  await eventually(
    () => twoWeeks(cal),
    (l) => {
      const [s] = titled(l, "Sync");
      expect([s?.summary, s?.busy]).toEqual(["🔒 Sync", true]);
    },
  );
  await cal.addEvent({ title: "Clash", start: at(day(1), "10:00"), end: at(day(1), "10:30") });
  await page.waitForTimeout(12_000);
  expect(starts(await twoWeeks(cal), "Sync")[0]).toBe(`${day(1)} 10:00-10:30`);
  await page.reload();
  await expect(page.locator(".ev-meeting.ev-locked", { hasText: "Sync" })).toBeVisible();

  // Unlock: the occurrence moves off the clash and is no longer locked.
  await page.locator(".ev-meeting", { hasText: "Sync" }).first().click();
  await page.getByTestId("event-drawer").getByRole("button", { name: "Unlock" }).click();
  await eventually(
    () => twoWeeks(cal),
    (l) => {
      const [s] = titled(l, "Sync");
      expect(s?.summary).toBe("○ Sync");
      expect(local(s?.start ?? 0)).not.toBe(`${day(1)} 10:00`);
      expect(local(s?.start ?? 0).slice(0, 10)).toBe(day(1));
    },
  );

  // A resize of next week's occurrence in the calendar is kept and locks it.
  const next = titled(await twoWeeks(cal), "Sync").find((e) => local(e.start).startsWith(day(8)));
  if (!next) throw new Error("no second occurrence");
  await cal.update(next.id, { start: at(day(8), "10:00"), end: at(day(8), "11:00") });
  await eventually(
    () => twoWeeks(cal),
    (l) => {
      const s = titled(l, "Sync").find((e) => local(e.start).startsWith(day(8)));
      expect([
        s?.summary,
        `${local(s?.start ?? 0)}-${local(s?.end ?? 0).slice(11)}`,
        s?.busy,
      ]).toEqual(["🔒 Sync", `${day(8)} 10:00-11:00`, true]);
    },
  );

  // A title edit and a free/busy edit in the calendar: the title stays, busy comes back.
  await editRaw(cal.calendarId, next.id, (lines) =>
    lines.map((l) =>
      l.startsWith("SUMMARY:")
        ? "SUMMARY:🔒 Sync in room 4"
        : l.startsWith("TRANSP:")
          ? "TRANSP:TRANSPARENT"
          : l,
    ),
  );
  await eventually(
    () => twoWeeks(cal),
    (l) => {
      const s = l.find((e) => e.summary.includes("room 4"));
      expect([s?.summary, s?.busy, local(s?.start ?? 0), local(s?.end ?? 0).slice(11)]).toEqual([
        "🔒 Sync in room 4",
        true,
        `${day(8)} 10:00`,
        "11:00",
      ]);
    },
    60_000,
  );

  await page.getByRole("link", { name: "Meetings" }).click();
  const occ = page.locator('[data-meeting-title="Sync"]').getByTestId("meeting-occurrences");
  await expect(occ).toContainText(`to 11:00 · locked`);
  await page.reload();
  await expect(occ).toContainText(`to 11:00 · locked`);
  const after = await twoWeeks(cal);
  expect(after.find((e) => e.summary.includes("room 4"))?.busy).toBe(true);
});

test("delete asks first: with email the guests get the cancelled times, without email they get nothing; both remove every future occurrence and the rules (MEET-02 rules 27-28)", async ({
  page,
  cal,
  signIn,
  mail,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await addMeeting(page, { title: "Sync", guests: "ana@example.com" });
  await addMeeting(page, { title: "Retro", guests: "ben@example.com", days: ["Thu"] });
  await eventually(
    () => twoWeeks(cal),
    (l) => {
      expect(starts(l, "Sync")).toEqual([`${day(1)} 10:00-10:30`, `${day(8)} 10:00-10:30`]);
      expect(starts(l, "Retro")).toEqual([`${day(3)} 10:00-10:30`, `${day(10)} 10:00-10:30`]);
    },
  );
  const sync = page.locator('[data-meeting-title="Sync"]');
  const retro = page.locator('[data-meeting-title="Retro"]');

  // Keep it closes the question and changes nothing.
  await sync.getByRole("button", { name: "Delete" }).click();
  await expect(sync.getByTestId("meeting-delete")).toContainText(
    "Delete Sync and its future times?",
  );
  await sync.getByRole("button", { name: "Keep it" }).click();
  await expect(sync.getByTestId("meeting-delete")).toHaveCount(0);
  await sync.getByRole("button", { name: "Delete" }).click();
  await sync.getByRole("button", { name: "Delete and email guests" }).click();
  await expect(sync).toHaveCount(0);
  await retro.getByRole("button", { name: "Delete" }).click();
  await retro.getByRole("button", { name: "Delete without email" }).click();
  await expect(retro).toHaveCount(0);

  await eventually(
    () => twoWeeks(cal),
    (l) => {
      expect(starts(l, "Sync")).toEqual([]);
      expect(starts(l, "Retro")).toEqual([]);
    },
  );
  const notice = await mail.message("ana@example.com", /Cancelled: Sync/);
  expect(notice.text).toContain(`${day(1)} 10:00`);
  expect(notice.text).toContain(`${day(8)} 10:00`);
  // Ben's notice would have gone out with Ana's.
  await page.waitForTimeout(3000);
  expect(await mail.count("ben@example.com")).toBe(0);

  await page.reload();
  await expect(page.getByTestId("meetings-page")).toContainText("No meetings yet.");
  expect(await mail.count("ana@example.com")).toBe(1);
});
