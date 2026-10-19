// The booking page view: the time zone picker, the 12- or 24-hour format, URL
// parameters, and the overlay of a signed-in booker's own calendar.
// Specs: booking-links-booking-page.md rules 6-10, 32-33 and edge case 1.
//
// Ways this can fail:
//  1. The picker does not list the actual zones first (the browser's, and the
//     signed-in user's calendar zone), or picking a zone does not convert the times.
//  2. The chosen zone or the chosen format is lost on reload.
//  3. The format ignores the browser locale by default, or the switch does not
//     change the labels.
//  4. URL parameters tz, duration, day and time are ignored; an invalid value
//     breaks the page instead of being ignored; a time that is not offered is selected.
//  5. Overlay: a signed-out booker gets the switch; the booker's events do not
//     show; the organizer's events show to the booker; the switch is gone after reload.
import type { Page } from "@playwright/test";
import { addDays, utcToLocal } from "../../src/shared/time.ts";
import { at, BASE_URL, blockUntil, expect, test, visitorContexts, ZONE } from "./fixtures.ts";
import { addLink, claimPage, slot, visitor, W } from "./helpers.ts";

const day = (n: number) => addDays(W, n);
const NY = "America/New_York";
const hm = (zone: string, t: number) => {
  const m = utcToLocal(zone, t).minuteOfDay;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};
const h12 = (zone: string, t: number) => {
  const m = utcToLocal(zone, t).minuteOfDay;
  const h = Math.floor(m / 60);
  return `${h % 12 || 12}:${String(m % 60).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
};
const zonePicker = (p: Page) => p.getByLabel("Time zone", { exact: true });
const firstDay = (p: Page) => p.getByTestId("day-times").first();

test("time zone picker and time format: the actual zones come first, times convert, and both choices survive a reload (page rules 6-8)", async ({
  page,
  browser,
  cal,
  signIn,
  colleague,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await claimPage(page, "tess");
  await addLink(page, { title: "Chat", durations: "30" });
  const t = at(W, "09:00");

  const v = await visitor(browser);
  await v.goto("/book/tess/chat");
  await expect(zonePicker(v)).toHaveValue(ZONE);
  await expect(slot(v, t)).toHaveText("09:00");
  await v.getByLabel("Search time zones").fill("new_y");
  await zonePicker(v).selectOption(NY);
  await expect(slot(v, t)).toHaveText(hm(NY, t));
  await expect(zonePicker(v).locator("option").first()).toHaveAttribute("value", ZONE);
  await expect(v.getByTestId("tz-note")).toContainText(`Times are in ${NY}`);
  await expect(v.getByTestId("tz-note")).toContainText(`Your browser's time zone is ${ZONE}`);
  await v.getByRole("button", { name: "12-hour" }).click();
  await expect(slot(v, t)).toHaveText(h12(NY, t));
  await v.reload();
  await expect(zonePicker(v)).toHaveValue(NY);
  await expect(slot(v, t)).toHaveText(h12(NY, t));
  await expect(v.getByRole("button", { name: "12-hour" })).toHaveAttribute("aria-pressed", "true");
  await v.getByRole("button", { name: "24-hour" }).click();
  await expect(slot(v, t)).toHaveText(hm(NY, t));

  // A browser with a US locale starts with the 12-hour format.
  const us = await browser.newContext({ timezoneId: ZONE, locale: "en-US", baseURL: BASE_URL });
  visitorContexts.push(us);
  const u = await us.newPage();
  await u.goto("/book/tess/chat");
  await expect(slot(u, t)).toHaveText("9:00 AM");

  // A signed-in booker also sees their calendar's zone near the top.
  const c = await colleague.signIn();
  await c.getByRole("link", { name: "Settings" }).click();
  await c.getByLabel("Time zone").fill("Asia/Tokyo");
  await c.getByLabel("Time zone").press("Tab");
  await expect(c.getByTestId("settings-message")).toHaveText("Saved");
  await c.goto("/book/tess/chat");
  await expect(zonePicker(c)).toHaveValue(ZONE);
  await expect(zonePicker(c).locator("option").nth(1)).toHaveAttribute("value", "Asia/Tokyo");
  await expect(zonePicker(c).locator("option").nth(1)).toContainText("your calendar");
  await zonePicker(c).selectOption("Asia/Tokyo");
  await expect(slot(c, t)).toHaveText(hm("Asia/Tokyo", t));
});

test("URL parameters choose the time zone, duration, day and time; invalid or unavailable values are ignored (page rule 9, edge case 1)", async ({
  page,
  browser,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await claimPage(page, "ugo");
  await addLink(page, { title: "Chat", durations: "30, 60" });
  const v = await visitor(browser);
  const url = `/book/ugo/chat?tz=Europe/London&duration=60&day=${day(1)}`;
  await v.goto(url);
  const durations = v.getByTestId("durations");
  await expect(durations.getByRole("button", { name: "60 min" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(zonePicker(v)).toHaveValue("Europe/London");
  await expect(firstDay(v)).toHaveAttribute("data-day", day(1));
  const first = firstDay(v).locator("button[data-start]").first();
  await expect(first).toHaveAttribute("data-start", String(at(day(1), "09:00")));
  await expect(first).toHaveText(hm("Europe/London", at(day(1), "09:00")));
  const hourLong = await firstDay(v).locator("button[data-start]").count();
  await durations.getByRole("button", { name: "30 min" }).click();
  await expect
    .poll(() => firstDay(v).locator("button[data-start]").count())
    .toBeGreaterThan(hourLong);
  await v.goto(url);
  await expect(firstDay(v)).toHaveAttribute("data-day", day(1));
  await expect(firstDay(v).locator("button[data-start]")).toHaveCount(hourLong);

  // `time` selects an offered start on that day and opens the details form.
  await v.goto(`/book/ugo/chat?tz=${ZONE}&day=${day(1)}&time=10:00`);
  await expect(v.getByTestId("book-form")).toBeVisible();
  await expect(v.getByTestId("book-form")).toContainText("10:00 to 10:30");
  // A time that is not offered: the date opens, no time is selected.
  await v.goto(`/book/ugo/chat?day=${day(1)}&time=10:10`);
  await expect(v.getByTestId("times")).toBeVisible();
  await expect(firstDay(v)).toHaveAttribute("data-day", day(1));
  await expect(v.getByTestId("book-form")).toHaveCount(0);
  // Invalid values are ignored.
  await v.goto("/book/ugo/chat?tz=Mars/Base&duration=45&day=someday&time=99:99");
  await expect(zonePicker(v)).toHaveValue(ZONE);
  await expect(durations.getByRole("button", { name: "30 min" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(slot(v, at(W, "09:00"))).toBeVisible();
  await expect(v.getByTestId("book-form")).toHaveCount(0);
});

test("overlay my calendar: a signed-in booker sees their own events next to the times, never the organizer's; signed-out bookers get no switch (page rules 10, 32-33)", async ({
  page,
  browser,
  cal,
  signIn,
  colleague,
}) => {
  await blockUntil(cal, W);
  await cal.addEvent({
    title: "A private review",
    start: at(day(1), "14:00"),
    end: at(day(1), "15:00"),
  });
  await colleague.cal.addEvent({
    title: "B dentist",
    start: at(day(1), "11:00"),
    end: at(day(1), "12:00"),
  });
  await signIn();
  await claimPage(page, "ursa");
  await addLink(page, { title: "Chat", durations: "30" });

  const v = await visitor(browser);
  await v.goto("/book/ursa/chat");
  await expect(v.getByTestId("times")).toBeVisible();
  await expect(v.getByLabel("Show my calendar")).toHaveCount(0);

  const b = await colleague.signIn();
  await b.goto(`/book/ursa/chat?day=${day(1)}`);
  await b.getByLabel("Show my calendar").check();
  const box = b.locator(`[data-testid="day-times"][data-day="${day(1)}"]`);
  await expect(box.getByTestId("my-events")).toContainText("11:00–12:00 B dentist");
  await expect(slot(b, at(day(1), "11:00"))).toHaveAttribute("data-mine", "busy");
  await expect(slot(b, at(day(1), "10:00"))).not.toHaveAttribute("data-mine", "busy");
  await expect(slot(b, at(day(1), "14:00"))).toHaveCount(0);
  await expect(b.getByTestId("booking-page")).not.toContainText("A private review");
  await b.reload();
  await expect(b.getByLabel("Show my calendar")).toBeChecked();
  await expect(box.getByTestId("my-events")).toContainText("11:00–12:00 B dentist");
  await expect(b.getByTestId("booking-page")).not.toContainText("A private review");
});
