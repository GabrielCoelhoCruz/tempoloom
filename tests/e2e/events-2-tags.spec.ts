// Event tags (docs/specs/events-tags.md): travel, flight and trip tags, the
// places Tempoloom reads a tag (title, description, the user's own RSVP note),
// the #tl_busy quick block and the focus tag.
//
// Ways this can fail, each covered below:
// - #tl_travel adds no travel time to an event without an address, or the tag
//   is read only from the title;
// - the user's RSVP note is not read, or another guest's note counts;
// - #tl_flight gives no airport time or no flight category;
// - #tl_trip adds a buffer, or does not make the event travel;
// - a longer word that starts with a tag (#tl_travels) counts as the tag;
// - removing a tag leaves its buffers on the calendar;
// - a busy event titled only #tl_busy stays busy, or a longer title is changed;
// - a #tl_focus event does not count toward the weekly focus goal.
import type { Page } from "@playwright/test";
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
  planNow,
  test,
} from "./fixtures.ts";
import { addTask, MIN, openWeek, titled, W } from "./helpers.ts";
import { putEvent } from "./ics.ts";

test.skip(BACKEND === "google", "Invitations with RSVP notes are written as raw CalDAV objects.");

const day = (n: number) => addDays(W, n);
const week = (cal: CalendarDriver) => cal.events(at(W, "00:00"), at(day(7), "00:00"));
const spans = (l: Awaited<ReturnType<typeof week>>, text: string) =>
  titled(l, text).map((e) => `${local(e.start)}-${local(e.end).slice(11)}`);
const external = (l: Awaited<ReturnType<typeof week>>, text: string) =>
  l.find(
    (e) => e.privateProps.tl !== "1" && (e.summary === text || e.summary.includes(`${text} `)),
  );

/** An accepted invitation from ines@; `notes` are RSVP notes by attendee email. */
const invitation = (
  cal: CalendarDriver,
  title: string,
  start: number,
  end: number,
  notes: Record<string, string>,
) =>
  putEvent(cal.calendarId, [
    `DTSTART:${new Date(start).toISOString().replace(/[-:]|\.\d{3}/g, "")}`,
    `DTEND:${new Date(end).toISOString().replace(/[-:]|\.\d{3}/g, "")}`,
    `SUMMARY:${title}`,
    "TRANSP:OPAQUE",
    "ORGANIZER:mailto:ines@example-c.test",
    "ATTENDEE;PARTSTAT=ACCEPTED:mailto:ines@example-c.test",
    ...[EMAIL, "otto@example-c.test"].map(
      (a) =>
        `ATTENDEE;PARTSTAT=ACCEPTED${notes[a] ? `;X-RESPONSE-COMMENT="${notes[a]}"` : ""}:mailto:${a}`,
    ),
  ]);

/** The planner details of an external event: "external · busy · Travel" and so on. */
async function details(page: Page, text: string): Promise<string> {
  await page.locator(".ev-external", { hasText: text }).first().click();
  const drawer = page.getByTestId("event-drawer");
  await expect(drawer).toBeVisible();
  const status = (await drawer.locator(".status").nth(1).textContent()) ?? "";
  await drawer.getByRole("button", { name: "Close", exact: true }).click();
  return status;
}

test("travel tags in the title, the description and the user's own RSVP note add travel time; #tl_flight adds airport time and #tl_trip only the travel category; a removed tag removes its buffers (events-tags rules 16-18, places 1-3, edge cases 4-5)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  const workshop = await cal.addEvent({
    title: "Workshop #tl_travel",
    start: at(day(1), "10:00"),
    end: at(day(1), "11:00"),
  });
  await cal.addEvent({
    title: "Board meeting",
    description: "Bring the slides. #TL_TRAVEL",
    start: at(day(1), "14:00"),
    end: at(day(1), "15:00"),
  });
  await cal.addEvent({
    title: "Lisbon trip #tl_flight",
    start: at(day(2), "10:00"),
    end: at(day(2), "12:00"),
  });
  await invitation(cal, "Supplier visit", at(day(3), "10:00"), at(day(3), "11:00"), {
    [EMAIL]: "#tl_travel",
  });
  await invitation(cal, "Partner review", at(day(3), "14:00"), at(day(3), "15:00"), {
    "otto@example-c.test": "#tl_travel",
  });
  await cal.addEvent({
    title: "Ride Ana home #tl_trip",
    start: at(day(4), "16:00"),
    end: at(day(4), "17:00"),
  });
  await cal.addEvent({
    title: "City tour #tl_travels",
    start: at(day(4), "10:00"),
    end: at(day(4), "11:00"),
  });
  await signIn();
  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Add travel time (30 min)" }).click();
  await expect(page.getByTestId("buffer-list")).toContainText("Travel");
  await page.getByRole("button", { name: /Add airport time/ }).click();
  await expect(page.getByTestId("buffer-list")).toContainText("Airport");

  const placed = await eventually(
    () => week(cal),
    (l) => {
      expect(titled(l, "Travel")).toHaveLength(6);
      expect(titled(l, "Airport")).toHaveLength(2);
      // The flight Tempoloom may edit gets its marker.
      expect(external(l, "Lisbon trip")?.summary).toBe("✈️ Lisbon trip #tl_flight");
    },
  );
  expect(spans(placed, "Travel")).toEqual([
    `${day(1)} 09:30-10:00`,
    `${day(1)} 11:00-11:30`,
    `${day(1)} 13:30-14:00`,
    `${day(1)} 15:00-15:30`,
    `${day(3)} 09:30-10:00`,
    `${day(3)} 11:00-11:30`,
  ]);
  expect(spans(placed, "Airport")).toEqual([`${day(2)} 08:00-10:00`, `${day(2)} 12:00-13:00`]);

  // The categories show in the planner and stay after a reload.
  const categories = async () => {
    await openWeek(page);
    expect(await details(page, "Ride Ana home")).toContain("Travel");
    expect(await details(page, "Lisbon trip")).toContain("Flight");
    expect(await details(page, "City tour")).toContain("Solo work");
  };
  await categories();
  await page.reload();
  await categories();

  // The user removes the tag in the calendar: the workshop's travel time goes.
  await cal.update(workshop, {
    start: at(day(1), "10:00"),
    end: at(day(1), "11:00"),
    summary: "Workshop",
  });
  const after = await eventually(
    () => week(cal),
    (l) => expect(titled(l, "Travel")).toHaveLength(4),
  );
  expect(spans(after, "Travel")).toEqual([
    `${day(1)} 13:30-14:00`,
    `${day(1)} 15:00-15:30`,
    `${day(3)} 09:30-10:00`,
    `${day(3)} 11:00-11:30`,
  ]);
  await page.reload();
  await openWeek(page);
  await expect(page.locator(".ev:not(.ev-external)", { hasText: "Travel" })).toHaveCount(4);
});

test("a busy event titled only #tl_busy turns free and still keeps tasks out; a longer title stays busy (events-tags rules 11-15)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await cal.addEvent({ title: "#tl_busy", start: at(W, "09:00"), end: at(W, "11:00") });
  await cal.addEvent({ title: "Hold #tl_busy", start: at(W, "11:00"), end: at(W, "12:00") });
  await signIn();
  await addTask(page, { title: "AT-Quick", minutes: 60, split: false, due: "" });
  const evs = await eventually(
    () => week(cal),
    (l) => {
      expect(external(l, "#tl_busy")?.busy).toBe(false);
      expect(titled(l, "AT-Quick")).toHaveLength(1);
    },
  );
  expect(external(evs, "Hold #tl_busy")?.busy).toBe(true);
  expect(spans(evs, "AT-Quick")).toEqual([`${W} 12:00-13:00`]);

  // Another run keeps the event free and the task out of its time.
  await planNow(page);
  await openWeek(page);
  await page.reload();
  await expect(page.locator(".ev-external", { hasText: "#tl_busy" })).toHaveCount(2);
  expect(await details(page, "Hold")).toContain("busy");
  await page.locator(".ev-external").filter({ hasNotText: "Hold" }).first().click();
  await expect(page.getByTestId("event-drawer").locator(".status").nth(1)).toContainText(
    "external · free",
  );
  const later = await week(cal);
  expect(external(later, "#tl_busy")?.busy).toBe(false);
  expect(spans(later, "AT-Quick")).toEqual([`${W} 12:00-13:00`]);
});

test("an event tagged #tl_focus counts toward the weekly focus goal, so less focus time is placed (events-tags rule 20, AT 6)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await cal.addEvent({
    title: "Design review prep #tl_focus",
    start: at(W, "09:00"),
    end: at(W, "11:00"),
  });
  await signIn();
  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Protect 10 hours of focus time per week" }).click();
  await eventually(
    () => week(cal),
    (l) =>
      expect(titled(l, "Focus time").reduce((a, e) => a + (e.end - e.start), 0)).toBe(480 * MIN),
  );
  await openWeek(page);
  const progress = page.getByTestId("focus-progress");
  await expect(progress).toContainText("10 h of 10 h this week");
  await page.reload();
  await expect(progress).toContainText("10 h of 10 h this week");
  const l = await week(cal);
  expect(titled(l, "Focus time").reduce((a, e) => a + (e.end - e.start), 0)).toBe(480 * MIN);
});
