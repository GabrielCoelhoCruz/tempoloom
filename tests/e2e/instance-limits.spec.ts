// Instance limits: Tempoloom has no paid tiers, so each reference plan limit
// is an operator setting, off by default, set with the CLI while the server
// runs (docs/specs/plans-feature-inventory.md rules 2-4, edge cases 1-2, T1,
// T2; accounts-connected-calendars.md plan limits; sync-calendar-mirroring.md
// plan limits).
//
// Ways it can fail, and the test that catches each:
// - the window limit does not cap planning, or caps booking links too       -> window
// - a user can still choose a longer window, or the page hides the limit    -> window
// - one more connected calendar than the limit can be checked               -> calendars
// - a lower limit leaves extra calendars connected, so they still block     -> calendars
// - one more mirroring policy, booking link or automation than the limit
//   can be created, or the refusal does not name the limit                  -> counts
// - items that exist when a limit applies stop working                      -> counts
// Every test reloads the pages and reads the state again.
import { addDays, localToUtc, utcToLocal } from "../../src/shared/time.ts";
import {
  addPolicy,
  calendarRow,
  copies,
  openSettings,
  setLimit,
  week,
} from "./calendar-helpers.ts";
import { at, BACKEND, blockUntil, eventually, expect, local, test, ZONE } from "./fixtures.ts";
import { addHabit, addLink, addTask, allEvents, claimPage, titled, visitor, W } from "./helpers.ts";

test.skip(BACKEND === "google", "Limit E2E uses CalDAV calendars.");

const DAY = 86_400_000;

test("a window limit caps planning but never booking links (plans rule 3; T1)", async ({
  page,
  app,
  browser,
  cal,
  signIn,
}) => {
  await signIn();
  await addHabit(page, { title: "AT-Daily", days: ["Mon", "Tue", "Wed", "Thu", "Fri"] });
  const today = utcToLocal(ZONE, Date.now()).date;
  const limitEnd = localToUtc(ZONE, addDays(today, 8), 0);
  const habits = () => cal.events(Date.now(), Date.now() + 30 * DAY);
  await eventually(habits, (l) =>
    expect(titled(l, "AT-Daily").some((e) => e.start >= limitEnd)).toBe(true),
  );

  setLimit(app, "max_scheduling_window_weeks", 1);
  await eventually(habits, (l) => {
    const h = titled(l, "AT-Daily");
    expect(h.length).toBeGreaterThan(0);
    expect(h.filter((e) => e.end > limitEnd)).toEqual([]);
  });
  await openSettings(page);
  const weeks = page.getByLabel("Plan ahead (weeks)");
  await expect(weeks).toHaveValue("1");
  await expect(page.getByTestId("window-limit")).toHaveText(
    "This server plans at most 1 week ahead.",
  );
  await weeks.fill("3");
  await weeks.press("Tab");
  await expect(page.getByTestId("settings-message")).toHaveText(
    "This server plans at most 1 week ahead.",
  );
  await page.reload();
  await expect(page.getByLabel("Plan ahead (weeks)")).toHaveValue("1");

  // Booking links are not limited: the booking page offers a time 20 days ahead.
  await claimPage(page, "ada");
  const v = await visitor(browser);
  await v.goto("/book/ada");
  await v.getByTestId("public-link").first().click();
  const late = localToUtc(ZONE, addDays(today, 20), 0);
  const starts = () =>
    v
      .locator('[data-testid="times"] button[data-start]')
      .evaluateAll((els) => els.map((e) => Number(e.getAttribute("data-start"))));
  // Open the link at the day 20 days ahead (URL parameter `day`).
  await expect(v.getByTestId("times")).toBeVisible();
  await v.goto(`${new URL(v.url()).pathname}?day=${addDays(today, 20)}`);
  await expect(v.getByTestId("times")).toBeVisible();
  expect((await starts()).some((s) => s >= late)).toBe(true);
});

test("a connected calendar limit refuses one more, and a lower limit turns the extras off (plans rule 4; connected calendars plan limits)", async ({
  page,
  app,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  const priv = await cal.newCalendar("Private");
  const side = await cal.newCalendar("Side");
  await side.addEvent({ title: "Side gig", start: at(W, "09:00"), end: at(W, "12:00") });
  void priv;
  await openSettings(page);
  await page.getByRole("button", { name: "Refresh calendar list" }).click();
  await calendarRow(page, "Private").getByRole("checkbox").check();
  await calendarRow(page, "Side").getByRole("checkbox").check();
  await addTask(page, { title: "AT-Limit", minutes: 60, split: false, due: "" });
  await eventually(
    () => allEvents(cal),
    (l) => expect(local(titled(l, "AT-Limit")[0]?.start ?? 0)).toBe(`${W} 12:00`),
  );

  // The operator lowers the limit to 2: the last calendar is turned off and stops blocking.
  setLimit(app, "max_connected_calendars", 2);
  await openSettings(page);
  await page.reload();
  await expect(calendarRow(page, "Work").getByRole("checkbox")).toBeChecked();
  await expect(calendarRow(page, "Private").getByRole("checkbox")).toBeChecked();
  await expect(calendarRow(page, "Side").getByRole("checkbox")).not.toBeChecked();
  await addTask(page, { title: "AT-After", minutes: 60, split: false, due: "" });
  await eventually(
    () => allEvents(cal),
    (l) => expect(local(titled(l, "AT-After")[0]?.start ?? 0)).toBe(`${W} 09:00`),
  );
  await openSettings(page);

  // One more is refused with a message that names the limit.
  await calendarRow(page, "Side").getByRole("checkbox").click();
  await expect(page.getByTestId("calendars-message")).toHaveText(
    "This server allows at most 2 connected calendars.",
  );
  await page.reload();
  await expect(calendarRow(page, "Side").getByRole("checkbox")).not.toBeChecked();
  // Without the limit, the calendar can be connected again.
  setLimit(app, "max_connected_calendars", "none");
  await calendarRow(page, "Side").getByRole("checkbox").check();
  await page.reload();
  await expect(calendarRow(page, "Side").getByRole("checkbox")).toBeChecked();
});

test("limits on mirroring policies, booking links and automations refuse one more with a message; existing ones keep working (plans rule 4, T2)", async ({
  page,
  app,
  cal,
  signIn,
}) => {
  await signIn();
  setLimit(app, "max_mirrors", 1);
  setLimit(app, "max_booking_links", 4);
  setLimit(app, "max_automations_per_user", 1);

  const priv = await cal.newCalendar("Private");
  await priv.addEvent({ title: "Dentist", start: at(W, "10:00"), end: at(W, "11:00") });
  await addPolicy(page, { from: "Private", to: "Work" });
  await addPolicy(page, {
    from: "Work",
    to: "Private",
    error: "This server allows at most 1 mirroring policy per person.",
  });
  await eventually(
    () => week(cal),
    (l) => expect(copies(l).map((e) => local(e.start))).toEqual([`${W} 10:00`]),
  );

  // Booking links: the page brings 3; a fourth fits; a fifth is refused.
  await claimPage(page, "ada");
  await expect(page.getByTestId("link-row")).toHaveCount(3);
  await addLink(page, { title: "Fourth" });
  const form = page.getByTestId("link-form");
  await form.getByLabel("Title").fill("Fifth");
  await form.getByRole("button", { name: "Add link" }).click();
  await expect(page.locator("p.error")).toHaveText(
    "This server allows at most 4 booking links per person.",
  );
  await page.reload();
  await expect(page.getByTestId("link-row")).toHaveCount(4);

  // Automations: one focus goal fits; a buffer and a habit are refused.
  await openSettings(page);
  await page.getByRole("button", { name: "Protect 10 hours of focus time per week" }).click();
  await expect(page.getByTestId("settings-message")).toHaveText("Saved");
  await page.getByRole("button", { name: "Add 15 min recovery after meetings" }).click();
  const automations =
    "This server allows at most 1 automation (habits, focus time and buffers) per person.";
  await expect(page.getByTestId("settings-message")).toHaveText(automations);
  await page.getByRole("link", { name: "Habits", exact: true }).click();
  const habit = page.getByTestId("habit-form");
  await habit.getByLabel("Title").fill("AT-Refused");
  await habit.getByRole("button", { name: "Add habit" }).click();
  await expect(page.getByRole("alert")).toHaveText(automations);
  await page.reload();
  await expect(page.locator('[data-habit-title="AT-Refused"]')).toHaveCount(0);
  await openSettings(page);
  await expect(page.getByTestId("buffer-list").locator("[data-buffer-title]")).toHaveCount(0);
  await expect(page.locator("[data-focus-title]")).toHaveCount(1);
  await expect(page.getByTestId("mirror-list").locator("[data-mirror]")).toHaveCount(1);
});
