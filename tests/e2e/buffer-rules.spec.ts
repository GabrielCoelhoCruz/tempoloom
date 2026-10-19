// Buffer and travel rules (docs/specs/buffers-automation.md,
// buffers-travel.md): several buffers per user, free or busy and visibility,
// priority against a habit, the conflict setting, the travel length, the
// flight category set by hand, a manual length that is kept, and travel time
// that a busy event blocks.
//
// Ways it can fail, and the check that catches each:
// - a second buffer automation replaces the first          -> both buffers on the calendar and in the list
// - a free or private buffer is written busy or public     -> transparency and CLASS
// - a P1 buffer does not displace a P3 habit, or a P4 buffer does
//                                                          -> habit and buffer spans per day
// - "Keep and mark the conflict" removes the buffer, or "Remove" keeps it
//                                                          -> conflict marker; buffer gone
// - the travel length is fixed at 30 minutes               -> 45-minute buffers
// - travel time is placed over a busy event                -> no buffer before the second meeting
// - a flight category set by hand gives travel time, not airport time
//                                                          -> buffer spans after the change and a reload
// - a resized travel buffer is put back, or stops following its event
//                                                          -> 45-minute buffer after the move
import { addDays } from "../../src/shared/time.ts";
import { day, openSettings, span, week } from "./automation-helpers.ts";
import {
  automation,
  create,
  edit,
  eventProp,
  fillEventSettings,
  openAutomations,
  rawEvent,
  save,
} from "./automation-list-helpers.ts";
import { at, BACKEND, blockUntil, eventually, expect, local, test } from "./fixtures.ts";
import { addHabit, openEvent, openWeek, titled, W } from "./helpers.ts";

const ADDRESS = "1 Oak Ave, Springfield, IL 62701";

test.skip(BACKEND === "google", "These checks read the CalDAV event data and invite guests.");

test("a user keeps several buffer automations, each with its own free or busy and visibility (rule 1; show_as, visibility)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  const tue = day(1);
  await cal.addEvent({
    title: "Customer call",
    start: at(tue, "10:00"),
    end: at(tue, "11:00"),
    attendees: ["ana@example.com"],
  });
  await signIn();
  const prep = await create(page, "Buffer");
  await prep.getByLabel("Title").fill("Prep");
  await prep.getByLabel("Side").selectOption({ label: "Before" });
  await prep.getByLabel("Before the event (minutes)").fill("10");
  await prep.getByLabel("Which events").selectOption({ label: "Meetings with other people" });
  await save(prep);
  const cool = await create(page, "Buffer");
  await cool.getByLabel("Title").fill("Cooldown");
  await fillEventSettings(cool, { visibility: "Private" });
  await cool.getByLabel("Side").selectOption({ label: "After" });
  await cool.getByLabel("After the event (minutes)").fill("15");
  await cool.getByLabel("Which events").selectOption({ label: "Meetings with other people" });
  await cool.getByLabel("Show as").selectOption({ label: "Free" });
  await save(cool);
  const evs = await eventually(
    () => week(cal),
    (l) => {
      expect(titled(l, "Prep").map(span)).toEqual([`${tue} 09:50-10:00`]);
      expect(titled(l, "Cooldown").map(span)).toEqual([`${tue} 11:00-11:15`]);
    },
  );
  const [p] = titled(evs, "Prep");
  const [c] = titled(evs, "Cooldown");
  expect(p?.busy).toBe(true);
  expect(c?.busy).toBe(false);
  expect(eventProp(await rawEvent(c?.id ?? ""), "CLASS")).toBe("PRIVATE");
  expect(eventProp(await rawEvent(p?.id ?? ""), "CLASS")).not.toBe("PRIVATE");
  await page.reload();
  await openAutomations(page);
  await expect(automation(page, "Prep")).toBeVisible();
  await expect(automation(page, "Cooldown")).toBeVisible();
  const again = await edit(page, "Cooldown");
  await expect(again.getByLabel("Show as").locator("option:checked")).toHaveText("Free");
  await expect(again.getByLabel("Visibility").locator("option:checked")).toHaveText("Private");
});

test("a P1 buffer takes the time of a P3 habit; a P4 buffer gives way to it (rules 11, 17)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  const [tue, wed] = [day(1), day(2)];
  await cal.addEvent({
    title: "Kickoff",
    start: at(tue, "11:00"),
    end: at(tue, "12:00"),
    attendees: ["ana@example.com"],
  });
  await signIn();
  await addHabit(page, {
    title: "Walk",
    ideal: "12:00",
    min: 15,
    max: 15,
    level: 3,
    days: ["Tue", "Wed"],
    defense: "Always busy",
  });
  await eventually(
    () => week(cal),
    (l) =>
      expect(titled(l, "Walk").map(span)).toEqual([`${tue} 12:00-12:15`, `${wed} 12:00-12:15`]),
  );
  const rec = await create(page, "Buffer");
  await rec.getByLabel("Title").fill("Recovery");
  await rec.getByLabel("Priority").selectOption({ label: "P1 critical" });
  await rec.getByLabel("Side").selectOption({ label: "After" });
  await rec.getByLabel("After the event (minutes)").fill("15");
  await rec.getByLabel("Which events").selectOption({ label: "Meetings with other people" });
  await save(rec);
  await eventually(
    () => week(cal),
    (l) => {
      expect(titled(l, "Recovery").map(span)).toEqual([`${tue} 12:00-12:15`]);
      expect(titled(l, "Walk").map(span)).toEqual([`${tue} 12:15-12:30`, `${wed} 12:00-12:15`]);
    },
  );
  // At P4 the buffer ranks below the habit: a new meeting on Wednesday gets no recovery.
  const low = await edit(page, "Recovery");
  await low.getByLabel("Priority").selectOption({ label: "P4 low" });
  await save(low);
  await cal.addEvent({
    title: "Review",
    start: at(wed, "11:00"),
    end: at(wed, "12:00"),
    attendees: ["ana@example.com"],
  });
  await page.reload();
  await page.waitForTimeout(6500);
  const after = await week(cal);
  expect(titled(after, "Walk").map(span)).toContain(`${wed} 12:00-12:15`);
  expect(titled(after, "Recovery").some((e) => local(e.start).startsWith(wed))).toBe(false);
});

test("the conflict setting keeps a buffer with the conflict marker or removes it (rule 16)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  const tue = day(1);
  await cal.addEvent({
    title: "Pitch",
    start: at(tue, "14:00"),
    end: at(tue, "15:00"),
    attendees: ["ana@example.com"],
  });
  await signIn();
  const prep = await create(page, "Buffer");
  await prep.getByLabel("Title").fill("Prep");
  await prep.getByLabel("Side").selectOption({ label: "Before" });
  await prep.getByLabel("Before the event (minutes)").fill("15");
  await prep.getByLabel("Which events").selectOption({ label: "Meetings with other people" });
  await prep
    .getByLabel("When the time is taken")
    .selectOption({ label: "Keep and mark the conflict" });
  await save(prep);
  const rec = await create(page, "Buffer");
  await rec.getByLabel("Title").fill("Recovery");
  await rec.getByLabel("Side").selectOption({ label: "After" });
  await rec.getByLabel("After the event (minutes)").fill("15");
  await rec.getByLabel("Which events").selectOption({ label: "Meetings with other people" });
  await rec.getByLabel("When the time is taken").selectOption({ label: "Remove the buffer" });
  await save(rec);
  await eventually(
    () => week(cal),
    (l) => {
      expect(titled(l, "Prep").map(span)).toEqual([`${tue} 13:45-14:00`]);
      expect(titled(l, "Recovery").map(span)).toEqual([`${tue} 15:00-15:15`]);
    },
  );
  await cal.addEvent({ title: "Call back", start: at(tue, "13:40"), end: at(tue, "13:55") });
  await cal.addEvent({ title: "Coffee", start: at(tue, "15:05"), end: at(tue, "15:20") });
  await eventually(
    () => week(cal),
    (l) => {
      const [p] = titled(l, "Prep");
      expect(p && span(p)).toBe(`${tue} 13:45-14:00`);
      expect(p?.summary).toBe("⚠️ Prep");
      expect(titled(l, "Recovery")).toHaveLength(0);
    },
  );
  await page.reload();
  await page.waitForTimeout(6000);
  const after = await week(cal);
  expect(titled(after, "Prep")[0]?.summary).toBe("⚠️ Prep");
  expect(titled(after, "Recovery")).toHaveLength(0);
  const again = await edit(page, "Prep");
  await expect(again.getByLabel("When the time is taken").locator("option:checked")).toHaveText(
    "Keep and mark the conflict",
  );
});

test("the user sets the travel length; travel time is skipped where a busy event blocks it (travel rules 3, 9)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  const [tue, wed] = [day(1), day(2)];
  await cal.addEvent({
    title: "Client visit",
    start: at(tue, "13:00"),
    end: at(tue, "14:00"),
    location: ADDRESS,
  });
  await cal.addEvent({ title: "Standup", start: at(wed, "11:30"), end: at(wed, "12:00") });
  await cal.addEvent({
    title: "Site walk",
    start: at(wed, "12:00"),
    end: at(wed, "13:00"),
    location: ADDRESS,
  });
  await signIn();
  const travel = await create(page, "Buffer");
  await travel.getByLabel("Title").fill("Travel");
  await travel
    .getByLabel("Which events")
    .selectOption({ label: "Events at an address (travel time)" });
  await travel.getByLabel("Side").selectOption({ label: "Before and after" });
  await travel.getByLabel("Before the event (minutes)").fill("45");
  await travel.getByLabel("After the event (minutes)").fill("45");
  await save(travel);
  const evs = await eventually(
    () => week(cal),
    (l) =>
      expect(titled(l, "Travel").map(span)).toEqual([
        `${tue} 12:15-13:00`,
        `${tue} 14:00-14:45`,
        `${wed} 13:00-13:45`,
      ]),
  );
  for (const e of titled(evs, "Travel")) {
    expect(e.busy).toBe(true);
    expect(e.summary).toBe("🚌 Travel");
  }
  await page.reload();
  await page.waitForTimeout(6000);
  expect(titled(await week(cal), "Travel").map(span)).toEqual([
    `${tue} 12:15-13:00`,
    `${tue} 14:00-14:45`,
    `${wed} 13:00-13:45`,
  ]);
  const again = await edit(page, "Travel");
  await expect(again.getByLabel("Before the event (minutes)")).toHaveValue("45");
});

test("an event set to the flight category by hand gets airport time instead of travel time (travel rules 4-6)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  const wed = day(2);
  await cal.addEvent({
    title: "To Lisbon",
    start: at(wed, "10:00"),
    end: at(wed, "12:00"),
    location: "Frankfurt Airport, Terminal 1, Gate A12",
  });
  await signIn();
  await openSettings(page);
  await page.getByRole("button", { name: "Add travel time (30 min)" }).click();
  await page.getByRole("button", { name: /Add airport time/ }).click();
  await expect(page.getByTestId("buffer-list")).toContainText("Airport");
  await eventually(
    () => week(cal),
    (l) => {
      expect(titled(l, "Travel").map(span)).toEqual([`${wed} 09:30-10:00`, `${wed} 12:00-12:30`]);
      expect(titled(l, "Airport")).toHaveLength(0);
    },
  );
  await openWeek(page);
  await page.locator(".ev-external", { hasText: "To Lisbon" }).click();
  await page.getByTestId("event-category").selectOption({ label: "Flight" });
  await eventually(
    () => week(cal),
    (l) => {
      expect(titled(l, "Airport").map(span)).toEqual([`${wed} 08:00-10:00`, `${wed} 12:00-13:00`]);
      expect(titled(l, "Travel")).toHaveLength(0);
    },
  );
  await page.reload();
  await page.locator(".ev-external", { hasText: "To Lisbon" }).click();
  await expect(page.getByTestId("event-category")).toHaveValue("flight");
  await page.waitForTimeout(6000);
  expect(titled(await week(cal), "Airport").map(span)).toEqual([
    `${wed} 08:00-10:00`,
    `${wed} 12:00-13:00`,
  ]);
});

test("travel buffers follow their event and keep a length the user changed (travel rules 10-11; buffers rule 14)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  const tue = day(1);
  const visit = await cal.addEvent({
    title: "Client visit",
    start: at(tue, "13:00"),
    end: at(tue, "14:00"),
    location: ADDRESS,
  });
  await signIn();
  await openSettings(page);
  await page.getByRole("button", { name: "Add travel time (30 min)" }).click();
  const evs = await eventually(
    () => week(cal),
    (l) =>
      expect(titled(l, "Travel").map(span)).toEqual([`${tue} 12:30-13:00`, `${tue} 14:00-14:30`]),
  );
  const [first] = titled(evs, "Travel");
  if (!first) throw new Error("no travel buffer");
  // The user gives the way there 15 more minutes in the calendar.
  await cal.update(first.id, { start: at(tue, "12:15"), end: at(tue, "13:00") });
  await page.waitForTimeout(6500);
  const kept = await week(cal);
  expect(titled(kept, "Travel").map(span)).toEqual([`${tue} 12:15-13:00`, `${tue} 14:00-14:30`]);
  expect(titled(kept, "Travel")[0]?.summary).toBe("🚌 Travel");
  // The visit moves one hour later: both buffers follow, the first keeps 45 minutes.
  await cal.update(visit, { start: at(tue, "14:00"), end: at(tue, "15:00") });
  await eventually(
    () => week(cal),
    (l) =>
      expect(titled(l, "Travel").map(span)).toEqual([`${tue} 13:15-14:00`, `${tue} 15:00-15:30`]),
  );
  await page.reload();
  await page.waitForTimeout(6000);
  expect(titled(await week(cal), "Travel").map(span)).toEqual([
    `${tue} 13:15-14:00`,
    `${tue} 15:00-15:30`,
  ]);
  await openWeek(page, addDays(W, 0));
  await openEvent(page, "Travel");
  await expect(page.getByTestId("event-drawer")).not.toContainText("locked");
});
