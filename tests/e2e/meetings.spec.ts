// Flexible meetings between two users of one instance
// (docs/specs/meetings-flexible.md, meetings-flexible-rescheduling.md).
import type { Page } from "@playwright/test";
import { addDays } from "../../src/shared/time.ts";
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
import { addHabit, openWeek, titled, W } from "./helpers.ts";

test.skip(BACKEND === "google", "Meeting E2E uses two CalDAV users.");

const day = (n: number) => addDays(W, n);
const twoWeeks = (cal: CalendarDriver) => cal.events(at(W, "00:00"), at(day(14), "00:00"));
const starts = (evs: Awaited<ReturnType<typeof twoWeeks>>, title: string) =>
  titled(evs, title).map((e) => `${local(e.start)}-${local(e.end).slice(11)}`);

async function addMeeting(
  page: Page,
  m: { title: string; guests: string; optional?: string; duration?: number; shortest?: number },
) {
  await page.getByRole("link", { name: "Meetings" }).click();
  const form = page.getByTestId("meeting-form");
  await form.getByLabel("Title").fill(m.title);
  await form.getByLabel("Guests (comma list)", { exact: true }).fill(m.guests);
  await form.getByLabel("Guests (comma list)", { exact: true }).blur();
  if (m.optional) await form.getByLabel("Optional guests (comma list)").fill(m.optional);
  if (m.duration) await form.getByLabel("Duration (minutes)").fill(String(m.duration));
  if (m.shortest) await form.getByLabel("Can shorten to (minutes)").fill(String(m.shortest));
}

test("a weekly meeting sits at the ideal time, moves around a colleague's busy time but not an unanswered invite, and moves the colleague's habit (rules 4-5, 8, 10-16, 27; MEET-02 1, 17, 27)", async ({
  page,
  cal,
  signIn,
  colleague,
}) => {
  await blockUntil(cal, W);
  await blockUntil(colleague.cal, W);
  const other = await colleague.signIn();
  await signIn();
  await addHabit(other, { title: "Review", ideal: "11:00", min: 30, max: 30 });

  await addMeeting(page, { title: "Sync", guests: `${colleague.email}, dana@example.com` });
  const info = page.getByTestId("attendee-info");
  await expect(info).toContainText(`${colleague.email}: Tempoloom user, Europe/Berlin`);
  await expect(info).toContainText(
    "dana@example.com: Tempoloom cannot see this person's availability or time zone.",
  );
  await page.getByRole("button", { name: "Preview" }).click();
  await expect(page.getByTestId("meeting-preview").locator(".row").first()).toContainText("10:00");
  await page.getByRole("button", { name: "Add meeting" }).click();

  const placed = await eventually(
    () => twoWeeks(cal),
    (l) => expect(starts(l, "Sync")).toEqual([`${day(1)} 10:00-10:30`, `${day(8)} 10:00-10:30`]),
  );
  const first = titled(placed, "Sync")[0];
  if (!first) throw new Error("no occurrence");
  expect(first.busy).toBe(false);
  expect(await cal.guests(first.id)).toEqual([
    { email: colleague.email, optional: false },
    { email: "dana@example.com", optional: false },
  ]);

  // The colleague is busy Tuesday 09:00 to 11:00; next week an unanswered invite
  // covers the same hours and must not count.
  await colleague.cal.addEvent({
    title: "Workshop",
    start: at(day(1), "09:00"),
    end: at(day(1), "11:00"),
  });
  await colleague.cal.addInvite({
    title: "Maybe",
    start: at(day(8), "09:00"),
    end: at(day(8), "11:00"),
    answer: "NEEDS-ACTION",
  });
  await eventually(
    () => twoWeeks(cal),
    (l) => expect(starts(l, "Sync")).toEqual([`${day(1)} 11:00-11:30`, `${day(8)} 10:00-10:30`]),
  );
  // The colleague's own planner treats the occurrence as fixed: the habit moves.
  await eventually(
    () => colleague.cal.events(at(day(1), "00:00"), at(day(3), "00:00")),
    (l) =>
      expect(titled(l, "Review").map((e) => local(e.start))).toEqual([
        `${day(1)} 11:30`,
        `${day(2)} 11:00`,
      ]),
  );

  // A move in the calendar locks the occurrence there.
  const next = titled(await twoWeeks(cal), "Sync").find((e) => local(e.start).startsWith(day(8)));
  if (!next) throw new Error("no second occurrence");
  await cal.update(next.id, { start: at(day(9), "15:00"), end: at(day(9), "15:30") });
  await eventually(
    () => twoWeeks(cal),
    (l) => {
      const moved = titled(l, "Sync").find((e) => local(e.start).startsWith(day(9)));
      expect(moved?.summary).toBe("🔒 Sync");
      expect(local(moved?.start ?? 0)).toBe(`${day(9)} 15:00`);
    },
  );
  await page.reload();
  const row = page.locator('[data-meeting-title="Sync"]');
  await expect(row.getByTestId("meeting-occurrences")).toContainText("11:00");
  await expect(row.getByTestId("meeting-occurrences")).toContainText("locked");
  await expect(row.getByTestId("meeting-attendees")).toContainText("Tempoloom cannot see");

  // Off removes the future occurrences that are not locked; the rules stay.
  await row.getByRole("button", { name: "Turn off" }).click();
  await eventually(
    () => twoWeeks(cal),
    (l) => expect(starts(l, "Sync")).toEqual([`${day(9)} 15:00-15:30`]),
  );
  await page.reload();
  await expect(page.locator('[data-meeting-title="Sync"]')).toContainText("off");
});

test("a colleague's meeting hours limit the time, a full slot shrinks to fit, optional guests do not count, and skip or delete drop one period (rules 11, 16-17, 35; MEET-02 20)", async ({
  page,
  cal,
  signIn,
  colleague,
}) => {
  await blockUntil(cal, W);
  await blockUntil(colleague.cal, W);
  const other = await colleague.signIn();
  await other.getByRole("link", { name: "Settings" }).click();
  for (const d of [1, 2, 3, 4, 5]) {
    await other.getByTestId(`range-meeting-${d}-0`).locator("input").first().fill("13:00");
  }
  await other.getByRole("button", { name: "Save meeting hours" }).click();
  await expect(other.getByTestId("settings-message")).toHaveText("Saved");
  await signIn();

  await addMeeting(page, {
    title: "Planning",
    guests: colleague.email,
    optional: "opt@example.com",
    duration: 60,
    shortest: 30,
  });
  await page.getByRole("button", { name: "Add meeting" }).click();
  const placed = await eventually(
    () => twoWeeks(cal),
    (l) =>
      expect(starts(l, "Planning")).toEqual([`${day(1)} 13:00-14:00`, `${day(8)} 13:00-14:00`]),
  );
  const first = titled(placed, "Planning")[0];
  expect(await cal.guests(first?.id ?? "")).toEqual([
    { email: colleague.email, optional: false },
    { email: "opt@example.com", optional: true },
  ]);

  // Only Tuesday 13:00 to 13:30 is left inside everyone's hours this week.
  for (const d of [0, 2, 3, 4]) {
    await cal.addEvent({ title: "Busy", start: at(day(d), "13:00"), end: at(day(d), "17:00") });
  }
  await cal.addEvent({ title: "Busy", start: at(day(1), "13:30"), end: at(day(1), "17:00") });
  await eventually(
    () => twoWeeks(cal),
    (l) =>
      expect(starts(l, "Planning")).toEqual([`${day(1)} 13:00-13:30`, `${day(8)} 13:00-14:00`]),
  );

  // Skip this week from the planner; delete next week's in the calendar.
  await openWeek(page);
  await page.locator(".ev-meeting", { hasText: "Planning" }).first().click();
  await page.getByTestId("event-drawer").getByRole("button", { name: "Skip this time" }).click();
  await eventually(
    () => twoWeeks(cal),
    (l) => expect(starts(l, "Planning")).toEqual([`${day(8)} 13:00-14:00`]),
  );
  const second = titled(await twoWeeks(cal), "Planning")[0];
  if (!second) throw new Error("no second occurrence");
  await cal.remove(second.id);
  await planNow(page);
  await page.waitForTimeout(12_000);
  expect(starts(await twoWeeks(cal), "Planning")).toEqual([]);
  await page.reload();
  expect(starts(await twoWeeks(cal), "Planning")).toEqual([]);
});
