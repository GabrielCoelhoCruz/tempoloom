// Focus time and buffer extras (docs/specs/focus-time.md rules 22 and 32,
// buffers-automation.md rule 18): focus time hidden from booking links, the
// reschedule action with a minimum delay, and a recovery buffer that gives its
// time to a habit at the habit's last slot.
//
// Ways it can fail, and the check that catches each:
// - with "offer to booking links" off a P1 link still offers focus time, or the
//   setting is lost on reload                             -> P1 slot before and after; checkbox
// - the reschedule ignores the delay, or the goal adds a second event for the
//   moved one, or the move is put back by the next plan   -> spans for a 1-hour and a 3-hour delay
// - the reschedule is offered on a focus event in progress -> no form at 11:10
// - the reschedule uses a range where the user deleted a
//   focus event of the goal (rule 21)                     -> span after a 4-hour delay
// - a recovery buffer keeps the habit's last slot, or yields where the habit
//   has other room                                        -> buffer and habit spans in two weeks
import { addDays, localToUtc } from "../../src/shared/time.ts";
import { day, minutesOf, openSettings, span, week } from "./automation-helpers.ts";
import { create, save } from "./automation-list-helpers.ts";
import { at, blockUntil, eventually, expect, planNow, test, ZONE } from "./fixtures.ts";
import { addHabit, claimPage, openEvent, openWeek, slot, titled, visitor, W } from "./helpers.ts";

test("with offer to booking links off, focus time is hidden from every booking link, also a P1 link (rule 32; offer_to_booking_links)", async ({
  page,
  browser,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await openSettings(page);
  const saved = page.waitForResponse(
    (r) => r.url().endsWith("/api/focus") && r.request().method() === "POST" && r.ok(),
  );
  await page.getByRole("button", { name: "Protect 10 hours of focus time per week" }).click();
  await saved;
  // The plan run writes the focus events one by one (on Google, one API call
  // each): read the calendar when it has ended, not the first events it wrote.
  await planNow(page);
  const evs = await eventually(
    () => week(cal),
    (l) => expect(titled(l, "Focus time").length).toBeGreaterThan(0),
  );
  const focus = titled(evs, "Focus time");
  const first = focus[0];
  if (!first) throw new Error("no focus time");
  await claimPage(page, "hana");
  const v = await visitor(browser);
  // The default offers focus time to a P1 link ("Important meeting").
  await v.goto("/book/hana/important-meeting");
  await expect(slot(v, first.start)).toBeVisible();

  await openSettings(page);
  const options = page.locator('[data-focus-options="Focus time"]');
  const offer = options.getByLabel("Offer focus time to P1 booking links");
  await expect(offer).toBeChecked();
  await offer.uncheck();
  await options.getByRole("button", { name: "Save focus options" }).click();
  await expect(options.getByTestId("focus-options-message")).toHaveText("Saved");
  await expect
    .poll(async () => {
      await v.reload();
      await expect(v.getByTestId("times")).toBeVisible();
      return slot(v, first.start).count();
    })
    .toBe(0);
  const starts = await v
    .locator('[data-testid="times"] button[data-start]')
    .evaluateAll((els) => els.map((e) => Number(e.getAttribute("data-start"))));
  for (const f of focus)
    expect(starts.some((s) => s < f.end && s + 30 * 60_000 > f.start)).toBe(false);
  // The focus events stay where they are.
  expect(titled(await week(cal), "Focus time").map(span)).toEqual(focus.map(span));
  await page.reload();
  await expect(
    page
      .locator('[data-focus-options="Focus time"]')
      .getByLabel("Offer focus time to P1 booking links"),
  ).not.toBeChecked();
});

test("reschedule moves a focus event to the first free time at least the chosen delay from now, and it stays there (rule 22)", async ({
  page,
  app,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  // Monday has free time 09:00-10:00, 11:00-12:00 and 13:00-14:30.
  await cal.addEvent({ title: "Review", start: at(W, "10:00"), end: at(W, "11:00") });
  await cal.addEvent({ title: "Sync", start: at(W, "12:00"), end: at(W, "13:00") });
  await cal.addEvent({ title: "Workshop", start: at(W, "14:30"), end: at(W, "17:00") });
  // The server's clock starts on Monday at 07:30, so "now" does not depend on the time of day.
  app.env.TEST_CLOCK_START = new Date(localToUtc(ZONE, W, 7 * 60 + 30)).toISOString();
  await app.restart();
  await signIn();
  const form = await create(page, "Focus time");
  await form.getByLabel("Title").fill("Deep work");
  await form.getByLabel("Weekly goal (hours)").fill("1");
  await form.getByLabel("Daily minimum (hours)").fill("0");
  await form.getByLabel("Daily maximum (hours)").fill("1");
  await form.getByLabel("Shortest block (minutes)").fill("60");
  await form.getByLabel("Longest block (minutes)").fill("60");
  await save(form);
  // The largest gap first.
  await eventually(
    () => week(cal),
    (l) => expect(titled(l, "Deep work").map(span)).toEqual([`${W} 13:00-14:00`]),
  );

  const reschedule = async (delay: string) => {
    await openWeek(page);
    await openEvent(page, "Deep work");
    const f = page.getByTestId("focus-reschedule-form");
    await f.getByLabel("At least").selectOption({ label: delay });
    const done = page.waitForResponse(
      (r) => r.request().method() === "POST" && /\/reschedule$/.test(new URL(r.url()).pathname),
    );
    await f.getByRole("button", { name: "Reschedule" }).click();
    expect((await done).ok()).toBe(true);
  };
  // 1 hour from 07:30 is 08:30: the first free hour starts at 09:00.
  await reschedule("1 hour");
  await eventually(
    () => week(cal),
    (l) => expect(titled(l, "Deep work").map(span)).toEqual([`${W} 09:00-10:00`]),
  );
  // 3 hours from 07:30 is 10:30: 10:30 to 11:00 is busy, so 11:00.
  await reschedule("3 hours");
  const check = (l: Awaited<ReturnType<typeof week>>) => {
    const f = titled(l, "Deep work");
    expect(f.map(span)).toEqual([`${W} 11:00-12:00`]);
    expect(minutesOf(f)).toBe(60);
  };
  await eventually(() => week(cal), check);
  await page.reload();
  await planNow(page);
  check(await week(cal));

  // While the event runs (the clock at 11:10), the planner does not offer the reschedule.
  app.env.TEST_CLOCK_START = new Date(localToUtc(ZONE, W, 11 * 60 + 10)).toISOString();
  await app.restart();
  await openWeek(page);
  await openEvent(page, "Deep work");
  await expect(page.getByTestId("event-actions")).toBeVisible();
  await expect(page.getByTestId("focus-reschedule-form")).toHaveCount(0);
  check(await week(cal));
});

test("reschedule does not put a focus event back where the user deleted one of the goal (rules 21, 22)", async ({
  page,
  app,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  // Monday has free time 09:00-10:00, 11:00-12:00 and 13:00-14:30.
  await cal.addEvent({ title: "Review", start: at(W, "10:00"), end: at(W, "11:00") });
  await cal.addEvent({ title: "Sync", start: at(W, "12:00"), end: at(W, "13:00") });
  await cal.addEvent({ title: "Workshop", start: at(W, "14:30"), end: at(W, "17:00") });
  app.env.TEST_CLOCK_START = new Date(localToUtc(ZONE, W, 7 * 60 + 30)).toISOString();
  await app.restart();
  await signIn();
  const form = await create(page, "Focus time");
  await form.getByLabel("Title").fill("Deep work");
  await form.getByLabel("Weekly goal (hours)").fill("1");
  await form.getByLabel("Daily minimum (hours)").fill("0");
  await form.getByLabel("Daily maximum (hours)").fill("1");
  await form.getByLabel("Shortest block (minutes)").fill("60");
  await form.getByLabel("Longest block (minutes)").fill("60");
  await save(form);
  const [placed] = titled(
    await eventually(
      () => week(cal),
      (l) => expect(titled(l, "Deep work").map(span)).toEqual([`${W} 13:00-14:00`]),
    ),
    "Deep work",
  );
  if (!placed) throw new Error("no focus event");
  // The user deletes it: the goal places its hour in another range.
  await cal.remove(placed.id);
  await eventually(
    () => week(cal),
    (l) => {
      const f = titled(l, "Deep work");
      expect(f).toHaveLength(1);
      expect(f[0]?.start).not.toBe(at(W, "13:00"));
    },
  );
  await openWeek(page);
  await openEvent(page, "Deep work");
  const f = page.getByTestId("focus-reschedule-form");
  await f.getByLabel("At least").selectOption({ label: "4 hours" });
  const done = page.waitForResponse(
    (r) => r.request().method() === "POST" && /\/reschedule$/.test(new URL(r.url()).pathname),
  );
  await f.getByRole("button", { name: "Reschedule" }).click();
  expect((await done).ok()).toBe(true);
  // 4 hours from 07:30 is 11:30. The first free hour after it is 13:00, where
  // the user deleted the focus event; 14:00 to 14:30 is too short.
  const check = (l: Awaited<ReturnType<typeof week>>) => {
    const moved = titled(l, "Deep work");
    expect(moved).toHaveLength(1);
    expect(moved[0]?.start).toBeGreaterThanOrEqual(at(W, "14:30"));
  };
  await eventually(() => week(cal), check);
  await page.reload();
  await planNow(page);
  check(await week(cal));
});

test("a recovery buffer gives its time to a habit when that is the habit's last slot, and keeps it where the habit has room (buffers rule 18)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  const next = day(7);
  // In week W only Monday 12:00 to 12:30 is free, right after a meeting.
  await cal.addEvent({ title: "Busy", start: at(W, "09:00"), end: at(W, "11:00") });
  await cal.addEvent({ title: "Busy", start: at(W, "12:30"), end: at(W, "17:00") });
  for (const n of [1, 2, 3, 4])
    await cal.addEvent({ title: "Busy", start: at(day(n), "09:00"), end: at(day(n), "17:00") });
  for (const d of [W, next]) {
    await cal.addEvent({
      title: "Kickoff",
      start: at(d, "11:00"),
      end: at(d, "12:00"),
      attendees: ["ana@example.com"],
    });
  }
  await signIn();
  // P1, so the buffer goes before the P3 habit (rule 17 alone keeps the buffer).
  const rec = await create(page, "Buffer");
  await rec.getByLabel("Title").fill("Recovery");
  await rec.getByLabel("Priority").selectOption({ label: "P1 critical" });
  await rec.getByLabel("Side").selectOption({ label: "After" });
  await rec.getByLabel("After the event (minutes)").fill("15");
  await rec.getByLabel("Which events").selectOption({ label: "Meetings with other people" });
  await save(rec);
  await eventually(
    () => cal.events(at(W, "00:00"), at(addDays(next, 7), "00:00")),
    (l) =>
      expect(titled(l, "Recovery").map(span)).toEqual([`${W} 12:00-12:15`, `${next} 12:00-12:15`]),
  );
  await addHabit(page, {
    title: "Walk",
    ideal: "12:00",
    min: 30,
    max: 30,
    level: 3,
    days: ["Mon"],
  });
  const check = (l: Awaited<ReturnType<typeof week>>) => {
    // Week W: the walk takes its only slot, and the buffer is gone.
    expect(titled(l, "Recovery").map(span)).toEqual([`${next} 12:00-12:15`]);
    const walks = titled(l, "Walk");
    expect(walks.filter((e) => e.start < at(next, "00:00")).map(span)).toEqual([
      `${W} 12:00-12:30`,
    ]);
    // Next week the walk has room elsewhere, so the buffer stays.
    const later = walks.filter(
      (e) => e.start >= at(next, "00:00") && e.start < at(day(8), "00:00"),
    );
    expect(later).toHaveLength(1);
    expect(later[0]?.start).toBeGreaterThanOrEqual(at(next, "12:15"));
    // The walk at its last slot turns busy.
    expect(walks[0]?.busy).toBe(true);
  };
  await eventually(() => cal.events(at(W, "00:00"), at(addDays(next, 7), "00:00")), check);
  await page.reload();
  await planNow(page);
  check(await cal.events(at(W, "00:00"), at(addDays(next, 7), "00:00")));
});
