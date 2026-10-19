// Booking link settings, second part: URL name, durations, notice, range,
// buffers, travel time, locations, CC guests, target calendar, focus time and
// preferred times (docs/specs/booking-links.md, booking-links-availability.md,
// booking-links-booking-page.md).
//
// Ways it can fail, and the test that catches each:
// - a new link with a title in use gets the same URL; a URL name change
//   keeps the old URL or takes one in use; the default duration is not
//   preselected; a fourth duration is saved                           -> url
// - times inside the notice are offered; times after the end date or
//   the rolling days are offered; the settings are lost on reload      -> range
// - times that leave no buffer before or after a busy event are offered;
//   travel time is not kept free for an address, or still kept when off -> buffers
// - the booker cannot choose a location or add CC guests; the event goes
//   to the main calendar instead of the chosen one; a reschedule drops
//   the location or the calendar                                       -> locations
// - a P2 link offers placed focus time, or a P1 link does not           -> focus
// - preferred times have no dot or legend, or a time next to a free
//   event is marked preferred                                          -> preferred
import type { Page } from "@playwright/test";
import { addDays, utcToLocal } from "../../src/shared/time.ts";
import {
  at,
  BACKEND,
  blockUntil,
  EMAIL,
  eventually,
  expect,
  local,
  test,
  ZONE,
} from "./fixtures.ts";
import { addLink, claimPage, slot, titled, visitor, W } from "./helpers.ts";
import { editLink, offered, saveLink } from "./link-helpers.ts";

const HOUR = 3_600_000;
const day = (n: number) => addDays(W, n);
const ADDRESS = "1 Oak Ave, Springfield, IL 62701";

/** All offered starts on the page, as local "YYYY-MM-DD HH:MM". */
async function allOffered(v: Page): Promise<string[]> {
  await expect(v.getByTestId("times")).toBeVisible();
  const starts = await v
    .locator('[data-testid="times"] button[data-start]')
    .evaluateAll((els) => els.map((e) => Number(e.getAttribute("data-start"))));
  return starts.map(local);
}

test("URL names: a title in use gets -2; the owner renames the URL, the old one stops working and a name in use is refused; up to 3 durations with a default that the page preselects (booking-links rules 4, 5; durations, defaultDuration)", async ({
  page,
  browser,
  signIn,
}) => {
  await signIn();
  await claimPage(page, "ula");
  await addLink(page, { title: "Intro call", durations: "15, 30, 60" });
  await addLink(page, { title: "Intro call!", durations: "30" });
  const v = await visitor(browser);
  await v.goto("/book/ula/intro-call-2");
  await expect(v.getByTestId("booking-page")).toContainText("Intro call!");

  // The first duration is the default until another is chosen.
  await v.goto("/book/ula/intro-call");
  await expect(v.getByRole("button", { name: "15 min" })).toHaveAttribute("aria-pressed", "true");

  let ed = await editLink(page, "Intro call");
  await ed.getByLabel(/Durations/).fill("15, 30, 60, 90");
  await ed.getByRole("button", { name: "Save link" }).click();
  await expect(ed.getByRole("alert")).toBeVisible();
  await ed.getByLabel(/Durations/).fill("15, 30, 60");
  await ed.getByLabel("Default duration (minutes)").fill("45");
  await ed.getByRole("button", { name: "Save link" }).click();
  await expect(ed.getByRole("alert")).toHaveText(
    "The default duration must be one of the durations.",
  );
  await ed.getByLabel("Default duration (minutes)").fill("30");
  await ed.getByLabel("URL name").fill("hello");
  await saveLink(page);

  ed = await editLink(page, "Intro call!");
  await ed.getByLabel("URL name").fill("hello");
  await ed.getByRole("button", { name: "Save link" }).click();
  await expect(ed.getByRole("alert")).toHaveText("That URL name is taken.");

  await v.goto("/book/ula/hello");
  await expect(v.getByTestId("booking-page")).toContainText("Intro call");
  await expect(v.getByRole("button", { name: "30 min" })).toHaveAttribute("aria-pressed", "true");
  await expect(v.getByTestId("durations").getByRole("button")).toHaveText([
    "15 min",
    "30 min",
    "60 min",
  ]);
  await v.goto("/book/ula/intro-call");
  await expect(v.getByText("This booking link does not exist.")).toBeVisible();

  await page.reload();
  ed = await editLink(page, "Intro call");
  await expect(ed.getByLabel("URL name")).toHaveValue("hello");
  await expect(ed.getByLabel("Default duration (minutes)")).toHaveValue("30");
  await expect(ed.getByLabel(/Durations/)).toHaveValue("15, 30, 60");
});

test("notice and range: no time inside the notice; the last day is a fixed date or today plus the rolling days; both survive a reload (booking-links rangeStart, rangeEnd; availability rule 6)", async ({
  page,
  browser,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await claimPage(page, "vera");
  await addLink(page, { title: "Soon", durations: "30" });
  // The notice ends between 11:00 and 12:00 on the first day of the test week.
  const notice = Math.ceil((at(W, "11:00") - Date.now()) / HOUR);
  const earliest = Date.now() + notice * HOUR;
  let ed = await editLink(page, "Soon");
  await ed.getByLabel("Notice (hours)").fill(String(notice));
  await ed.getByLabel("Or up to a date").fill(day(1));
  await saveLink(page);

  const v = await visitor(browser);
  await v.goto("/book/vera/soon");
  let times = await allOffered(v);
  expect(times.length).toBeGreaterThan(0);
  expect(times.some((t) => t.startsWith(W) && t < `${W} 11:00`)).toBe(false);
  expect(Math.min(...(await startsOf(v)))).toBeGreaterThanOrEqual(earliest);
  expect(times.some((t) => t.startsWith(day(1)))).toBe(true);
  expect(times.some((t) => t >= `${day(2)} 00:00`)).toBe(false);

  // Rolling days: the last day is today plus N days.
  const today = utcToLocal(ZONE, Date.now()).date;
  let n = 0;
  while (addDays(today, n) < day(2)) n++;
  ed = await editLink(page, "Soon");
  await ed.getByLabel("Or up to a date").fill("");
  await ed.getByLabel("Book up to (days ahead)").fill(String(n));
  await saveLink(page);
  await v.reload();
  times = await allOffered(v);
  expect(times.some((t) => t.startsWith(day(2)))).toBe(true);
  expect(times.some((t) => t >= `${day(3)} 00:00`)).toBe(false);

  await page.reload();
  ed = await editLink(page, "Soon");
  await expect(ed.getByLabel("Notice (hours)")).toHaveValue(String(notice));
  await expect(ed.getByLabel("Book up to (days ahead)")).toHaveValue(String(n));
  await expect(ed.getByLabel("Or up to a date")).toHaveValue("");
});

async function startsOf(v: Page): Promise<number[]> {
  return v
    .locator('[data-testid="times"] button[data-start]')
    .evaluateAll((els) => els.map((e) => Number(e.getAttribute("data-start"))));
}

test("buffers: times that leave no buffer before or after a busy event are not offered; at an address the travel time stays free while the link keeps it, and not after it is turned off (availability rule 10; booking-links rule 28)", async ({
  page,
  browser,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await cal.addEvent({ title: "Review", start: at(day(1), "12:00"), end: at(day(1), "13:00") });
  await cal.addEvent({ title: "Standup", start: at(day(2), "09:00"), end: at(day(2), "10:00") });
  await cal.addEvent({ title: "Lunch", start: at(day(2), "15:00"), end: at(day(2), "16:00") });
  await signIn();
  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Add travel time (30 min)" }).click();
  await expect(page.getByTestId("buffer-list")).toContainText("Travel");
  await claimPage(page, "wes");
  await addLink(page, { title: "Buffered", durations: "30" });
  await addLink(page, { title: "Visit", durations: "30" });
  let ed = await editLink(page, "Buffered");
  await ed.getByLabel("Buffer before (minutes)").fill("30");
  await ed.getByLabel("Buffer after (minutes)").fill("30");
  await saveLink(page);
  ed = await editLink(page, "Visit");
  await ed.getByTestId("location-1").getByLabel("Kind").selectOption({ label: "Address" });
  await ed.getByLabel("Location 1").fill(ADDRESS);
  await saveLink(page);

  const v = await visitor(browser);
  await v.goto("/book/wes/buffered");
  const tue = await offered(v, day(1));
  expect(tue).toContain("11:00");
  expect(tue).not.toContain("11:30");
  expect(tue).not.toContain("13:00");
  expect(tue).toContain("13:30");

  await v.goto("/book/wes/visit");
  let wed = await offered(v, day(2));
  expect(wed).not.toContain("10:00");
  expect(wed).toContain("10:30");
  expect(wed).toContain("14:00");
  expect(wed).not.toContain("14:30");
  // Away from an address no travel time applies: Buffered has no location.
  await v.goto("/book/wes/buffered");
  expect(await offered(v, day(2))).toContain("10:30");

  ed = await editLink(page, "Visit");
  await expect(ed.getByLabel("Keep travel time free")).toBeChecked();
  await ed.getByLabel("Keep travel time free").uncheck();
  await saveLink(page);
  await v.goto("/book/wes/visit");
  wed = await offered(v, day(2));
  expect(wed).toContain("10:00");
  expect(wed).toContain("14:30");

  await page.reload();
  ed = await editLink(page, "Visit");
  await expect(ed.getByLabel("Keep travel time free")).not.toBeChecked();
  ed = await editLink(page, "Buffered");
  await expect(ed.getByLabel("Buffer before (minutes)")).toHaveValue("30");
  await expect(ed.getByLabel("Buffer after (minutes)")).toHaveValue("30");
});

test("locations, CC and calendar: the booker chooses one of the link's locations and adds CC guests; the busy event goes to the chosen calendar with the location, guests and manage links, and keeps them on reschedule (booking-links rules 12-13, locations, targetCalendar; page details form)", async ({
  page,
  browser,
  cal,
  signIn,
}) => {
  test.skip(BACKEND === "google", "A second calendar needs CalDAV.");
  await blockUntil(cal, W);
  const bookings = await cal.newCalendar("Bookings");
  await signIn();
  await claimPage(page, "xia");
  await addLink(page, { title: "Talk", durations: "30" });
  let ed = await editLink(page, "Talk");
  await ed.getByTestId("location-1").getByLabel("Kind").selectOption({ label: "Address" });
  await ed.getByLabel("Location 1").fill(ADDRESS);
  await ed.getByRole("button", { name: "+ Add location" }).click();
  await ed.getByTestId("location-2").getByLabel("Kind").selectOption({ label: "Phone" });
  await ed.getByLabel("Location 2").fill("+49 30 1234567");
  await ed.getByRole("button", { name: "+ Add location" }).click();
  await ed
    .getByTestId("location-3")
    .getByLabel("Kind")
    .selectOption({ label: "Other (text or URL)" });
  await ed.getByLabel("Location 3").fill("https://meet.example.org/xia");
  // The phone becomes the default: it moves first.
  await ed.getByTestId("location-2").getByLabel("Default").click();
  await expect(ed.getByLabel("Location 1")).toHaveValue("+49 30 1234567");
  await ed.getByLabel("Calendar for booked events").selectOption({ label: `Bookings (${EMAIL})` });
  await saveLink(page);

  const v = await visitor(browser);
  await v.goto("/book/xia/talk");
  await expect(v.getByTestId("booking-page")).toContainText("Location: +49 30 1234567");
  await slot(v, at(day(1), "10:00")).click();
  const form = v.getByTestId("book-form");
  await expect(form.getByLabel("Location")).toHaveValue("0");
  await form.getByLabel("Location").selectOption({ label: "Other: https://meet.example.org/xia" });
  await form.getByLabel(/^CC/).fill("cc1@example.com, cc2@example.com");
  await form.getByLabel("Your name").fill("Yan");
  await form.getByLabel("Your email").fill("yan@example.com");
  await form.getByRole("button", { name: "Book" }).click();
  await expect(v.getByTestId("booked-location")).toHaveText(
    "Location: https://meet.example.org/xia",
  );

  const span = () => bookings.events(at(W, "00:00"), at(day(7), "00:00"));
  const booked = await eventually(span, (l) =>
    expect(l.find((e) => e.summary === "Talk with Yan")).toBeDefined(),
  );
  const ev = booked.find((e) => e.summary === "Talk with Yan");
  if (!ev) throw new Error("no booked event");
  expect([local(ev.start), ev.busy, ev.location]).toEqual([
    `${day(1)} 10:00`,
    true,
    "https://meet.example.org/xia",
  ]);
  expect(ev.description).toContain("/book/manage/");
  expect((await bookings.guests(ev.id)).map((g) => g.email).sort()).toEqual([
    "cc1@example.com",
    "cc2@example.com",
    "yan@example.com",
  ]);
  const main = await cal.events(at(W, "00:00"), at(day(7), "00:00"));
  expect(main.find((e) => e.summary === "Talk with Yan")).toBeUndefined();

  // A reschedule keeps the calendar, the location and the guests.
  await v.getByTestId("manage-link").click();
  await v.getByRole("button", { name: "Reschedule" }).click();
  await slot(v, at(day(2), "11:00")).click();
  await expect(v.getByText("Your booking has a new time.")).toBeVisible();
  const moved = await eventually(span, (l) =>
    expect(local(l.find((e) => e.summary === "Talk with Yan")?.start ?? 0)).toBe(`${day(2)} 11:00`),
  );
  const again = moved.find((e) => e.summary === "Talk with Yan");
  expect(again?.location).toBe("https://meet.example.org/xia");
  expect((await bookings.guests(again?.id ?? "")).map((g) => g.email)).toContain("cc2@example.com");

  await page.reload();
  ed = await editLink(page, "Talk");
  await expect(ed.getByLabel("Location 1")).toHaveValue("+49 30 1234567");
  await expect(ed.getByLabel("Location 2")).toHaveValue(ADDRESS);
  await expect(ed.getByLabel("Location 3")).toHaveValue("https://meet.example.org/xia");
  await expect(ed.getByLabel("Calendar for booked events")).toHaveValue(/.+/);
  await expect(ed.getByLabel("Calendar for booked events").locator("option:checked")).toHaveText(
    `Bookings (${EMAIL})`,
  );
});

test("placed focus time is offered by a P1 link only (availability notes on classes; focus-time rule 32)", async ({
  page,
  browser,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Protect 10 hours of focus time per week" }).click();
  const evs = await eventually(
    () => cal.events(at(W, "00:00"), at(day(5), "00:00")),
    (l) => expect(titled(l, "Focus time").length).toBeGreaterThan(0),
  );
  const focus = titled(evs, "Focus time").filter((e) => e.busy);
  const first = focus[0];
  if (!first) throw new Error("no busy focus time");
  await claimPage(page, "yuri");
  const v = await visitor(browser);
  // Starter links: "Important meeting" is P1, "Meeting" is P2.
  await v.goto("/book/yuri/important-meeting");
  await expect(slot(v, first.start)).toBeVisible();
  await v.goto("/book/yuri/meeting");
  await expect(v.getByTestId("times")).toBeVisible();
  const p2 = await startsOf(v);
  for (const f of focus) expect(p2.some((s) => s < f.end && s + 30 * 60_000 > f.start)).toBe(false);
  await v.reload();
  await expect(v.getByTestId("times")).toBeVisible();
  await expect(slot(v, first.start)).toHaveCount(0);
});

test("preferred times: a time with nothing else on the calendar has a green dot and the legend explains it; a time over a free event is offered without the dot (availability rule 15; page rule 5)", async ({
  page,
  browser,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await cal.addEvent({
    title: "Maybe coffee",
    start: at(day(1), "09:00"),
    end: at(day(1), "10:00"),
    busy: false,
  });
  await signIn();
  await claimPage(page, "zoe");
  const v = await visitor(browser);
  await v.goto("/book/zoe/meeting");
  await expect(v.getByTestId("preferred-legend")).toHaveText(
    "Preferred: the organizer has nothing else then.",
  );
  const check = async () => {
    for (const t of ["09:00", "09:30"]) {
      await expect(slot(v, at(day(1), t))).toBeVisible();
      await expect(slot(v, at(day(1), t))).not.toHaveAttribute("data-preferred", "1");
      await expect(slot(v, at(day(1), t)).locator(".dot")).toHaveCount(0);
    }
    await expect(slot(v, at(day(1), "10:00"))).toHaveAttribute("data-preferred", "1");
    await expect(slot(v, at(day(1), "10:00")).locator(".dot")).toBeVisible();
  };
  await check();
  await v.reload();
  await check();
});
