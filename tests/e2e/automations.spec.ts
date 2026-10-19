// The automation list and the shared automation form
// (docs/specs/automations-overview.md, planning-priorities.md PRI-54,
// automations-library.md rule 4).
//
// Ways this can fail, and the test that catches each:
// - A type is missing from the list, or sits in the wrong priority group or
//   rank order (list groups test).
// - The type filter shows other types, or forgets the choice on reload (list
//   groups test).
// - The create button does not open the shared form, or the form saves an
//   automation that does not plan (list groups test, shared form tests in
//   event-settings.spec.ts).
// - Focus time can be dragged out of P4, or cannot be ranked inside P4 (list
//   groups test).
// - A drag changes the list but not the scheduler order; a drag to another group
//   does not change the priority; the order is lost on reload (drag test).
// - Turning an automation off keeps its future events or loses its settings;
//   remove runs without a confirm, or keeps future events (off and remove test).
// - The "Added" badge follows the name, so a rename loses it and a hand-made
//   automation with a template's name gets it (library test).
import { addDays } from "../../src/shared/time.ts";
import {
  automation,
  create,
  edit,
  group,
  names,
  openAutomations,
  save,
} from "./automation-list-helpers.ts";
import {
  at,
  blockUntil,
  type CalendarDriver,
  eventually,
  expect,
  local,
  test,
} from "./fixtures.ts";
import { addHabit, titled, W } from "./helpers.ts";

const day = (n: number) => addDays(W, n);
const week = (cal: CalendarDriver) => cal.events(at(W, "00:00"), at(day(7), "00:00"));
const spans = (evs: Awaited<ReturnType<typeof week>>, text: string) =>
  titled(evs, text).map((e) => `${local(e.start)}-${local(e.end).slice(11)}`);

test("the automation list groups every type by priority, filters by type, and keeps focus time in P4 (rules 1, 6-10; PRI-54)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await addHabit(page, { title: "Read", ideal: "09:00", min: 30, max: 30, level: 2 });
  await addHabit(page, { title: "Walk", ideal: "16:00", min: 30, max: 30, level: 3 });
  await addHabit(page, { title: "Email", ideal: "16:30", min: 30, max: 30, level: 4 });
  await page.getByRole("link", { name: "Meetings" }).click();
  const meeting = page.getByTestId("meeting-form");
  await meeting.getByLabel("Title").fill("Sync");
  await meeting.getByLabel("Guests (comma list)", { exact: true }).fill("dana@example.com");
  await meeting.getByRole("button", { name: "Add meeting" }).click();
  await expect(page.locator('[data-meeting-title="Sync"]')).toBeVisible();

  // The top-bar create button opens the shared form (rule 1).
  const buffer = await create(page, "Buffer");
  await buffer.getByLabel("Title").fill("Prep");
  await buffer.getByLabel("Side").selectOption({ label: "Before" });
  await buffer.getByLabel("Before the event (minutes)").fill("15");
  await buffer.getByLabel("Which events").selectOption({ label: "Meetings with other people" });
  await buffer.getByLabel("Priority").selectOption({ label: "P3 medium" });
  await save(buffer);
  const focus = await create(page, "Focus time");
  await focus.getByLabel("Title").fill("Deep work");
  await focus.getByLabel("Weekly goal (hours)").fill("2");
  await save(focus);

  // Rule 6, 7: four groups, P1 at the top; the rank order inside a group is the
  // scheduler's order (meetings, then buffers, then habits at one rank).
  const groups = async () => ({
    1: await names(group(page, 1)),
    2: await names(group(page, 2)),
    3: await names(group(page, 3)),
    4: await names(group(page, 4)),
  });
  const expected = { 1: [], 2: ["Sync", "Read"], 3: ["Prep", "Walk"], 4: ["Email", "Deep work"] };
  await expect.poll(groups).toEqual(expected);
  await expect(automation(page, "Sync")).toContainText("Flexible meeting");
  await expect(automation(page, "Prep")).toContainText("Buffer");
  await expect(automation(page, "Read")).toContainText("Habit");
  await expect(automation(page, "Deep work")).toContainText("Focus time");
  // Rule 8: focus time has no priority choice.
  await expect(automation(page, "Deep work").getByLabel("Priority")).toBeDisabled();

  // Rule 10: filter by type; the choice stays after a reload.
  await page.getByLabel("Type", { exact: true }).selectOption({ label: "Buffers" });
  await expect.poll(() => names(page.getByTestId("automations-page"))).toEqual(["Prep"]);
  await page.reload();
  await expect.poll(() => names(page.getByTestId("automations-page"))).toEqual(["Prep"]);
  await page.getByLabel("Type", { exact: true }).selectOption({ label: "Flexible meetings" });
  await expect.poll(() => names(page.getByTestId("automations-page"))).toEqual(["Sync"]);
  await page.getByLabel("Type", { exact: true }).selectOption({ label: "All types" });
  await expect.poll(groups).toEqual(expected);

  // Rule 8: a drop of focus time on another group is refused; inside P4 it ranks.
  await automation(page, "Deep work").dragTo(group(page, 1));
  await expect.poll(groups).toEqual(expected);
  await automation(page, "Deep work").dragTo(automation(page, "Email"));
  await expect.poll(() => names(group(page, 4))).toEqual(["Deep work", "Email"]);
  await page.reload();
  await expect.poll(groups).toEqual({ ...expected, 4: ["Deep work", "Email"] });
});

test("dragging an automation changes its rank or its priority, and the scheduler follows the new order (rules 7, 14, 16; AT 2)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  // Monday has one free hour, 13:00 to 14:00; the other days have room for both.
  await cal.addEvent({ title: "Morning block", start: at(W, "09:00"), end: at(W, "13:00") });
  await cal.addEvent({ title: "Afternoon block", start: at(W, "14:00"), end: at(W, "17:00") });
  await signIn();
  for (const title of ["Alpha", "Beta"]) {
    await addHabit(page, {
      title,
      ideal: "13:00",
      min: 60,
      max: 60,
      level: 2,
      noRoom: "Remove that day",
    });
  }
  const monday = (evs: Awaited<ReturnType<typeof week>>) =>
    ["Alpha", "Beta"].filter((t) => spans(evs, t).includes(`${W} 13:00-14:00`));
  await eventually(
    () => week(cal),
    (l) => {
      expect(monday(l)).toEqual(["Alpha"]);
      expect(spans(l, "Beta").filter((s) => s.startsWith(W))).toEqual([]);
    },
  );

  await openAutomations(page);
  await expect.poll(() => names(group(page, 2))).toEqual(["Alpha", "Beta"]);
  // Rank: Beta above Alpha gives Beta the slot (rule 16).
  await automation(page, "Beta").dragTo(automation(page, "Alpha"));
  await expect.poll(() => names(group(page, 2))).toEqual(["Beta", "Alpha"]);
  await eventually(
    () => week(cal),
    (l) => {
      expect(monday(l)).toEqual(["Beta"]);
      expect(spans(l, "Alpha").filter((s) => s.startsWith(W))).toEqual([]);
    },
  );
  await page.reload();
  await expect.poll(() => names(group(page, 2))).toEqual(["Beta", "Alpha"]);

  // Priority: Alpha dropped on the P1 group becomes P1 and takes the slot back.
  await automation(page, "Alpha").dragTo(group(page, 1));
  await expect.poll(() => names(group(page, 1))).toEqual(["Alpha"]);
  await eventually(
    () => week(cal),
    (l) => expect(monday(l)).toEqual(["Alpha"]),
  );
  await page.reload();
  await expect.poll(() => names(group(page, 1))).toEqual(["Alpha"]);
  await expect.poll(() => names(group(page, 2))).toEqual(["Beta"]);
  await page.getByRole("link", { name: "Habits" }).click();
  await expect(page.locator('[data-habit-title="Alpha"]')).toContainText("P1 critical");
});

test("turning an automation off removes its future events and keeps its settings; remove asks first, then deletes it and its future events (rules 11-13; AT 4)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await cal.addEvent({
    title: "Customer call",
    start: at(day(1), "10:00"),
    end: at(day(1), "11:00"),
    attendees: ["ana@example.com"],
  });
  await signIn();
  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Add 15 min recovery after meetings" }).click();
  await eventually(
    () => week(cal),
    (l) => expect(spans(l, "Recovery")).toEqual([`${day(1)} 11:00-11:15`]),
  );

  await openAutomations(page);
  await automation(page, "Recovery").getByRole("button", { name: "Turn off" }).click();
  await expect(automation(page, "Recovery")).toContainText("Off");
  await eventually(
    () => week(cal),
    (l) => expect(spans(l, "Recovery")).toEqual([]),
  );
  await page.reload();
  await expect(automation(page, "Recovery")).toContainText("Off");
  await automation(page, "Recovery").getByRole("button", { name: "Turn on" }).click();
  await eventually(
    () => week(cal),
    (l) => expect(spans(l, "Recovery")).toEqual([`${day(1)} 11:00-11:15`]),
  );

  // Rule 13: remove asks first; cancel keeps everything.
  await automation(page, "Recovery").getByRole("button", { name: "Remove" }).click();
  const confirm = automation(page, "Recovery").getByRole("alertdialog");
  await expect(confirm).toContainText("Remove Recovery and its future events?");
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(confirm).toBeHidden();
  await page.reload();
  await expect(automation(page, "Recovery")).toBeVisible();
  await automation(page, "Recovery").getByRole("button", { name: "Remove" }).click();
  await automation(page, "Recovery")
    .getByRole("alertdialog")
    .getByRole("button", { name: "Yes, remove" })
    .click();
  await expect(automation(page, "Recovery")).toHaveCount(0);
  await eventually(
    () => week(cal),
    (l) => expect(spans(l, "Recovery")).toEqual([]),
  );
  await page.reload();
  await expect(page.getByTestId("automations-page")).toBeVisible();
  await expect(automation(page, "Recovery")).toHaveCount(0);
});

test("a library entry opens the shared form with its preset; Added follows the template, so a rename keeps it and a hand-made automation with the same name does not get it (rules 1-3; library rule 4)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await cal.addEvent({
    title: "Interview with Bo",
    start: at(day(1), "15:00"),
    end: at(day(1), "15:30"),
    attendees: ["bo@example.com"],
  });
  await signIn();
  // A habit made by hand with the name of a library entry.
  await addHabit(page, { title: "Daily walk", ideal: "12:30", min: 30, max: 30 });

  const library = async () => {
    await page.getByRole("link", { name: "Library" }).click();
    await expect(page.getByTestId("library-page")).toBeVisible();
  };
  const entry = (name: string) => page.locator(`[data-entry="${name}"]`);
  await library();
  await expect(entry("Daily walk")).toBeVisible();
  await expect(entry("Daily walk")).not.toContainText("Added");

  await entry("Prep before interviews").getByRole("button", { name: "Use" }).click();
  const form = page.getByTestId("automation-form");
  await expect(form.getByLabel("Title")).toHaveValue("Prep before interviews");
  await expect(form.getByLabel("Before the event (minutes)")).toHaveValue("15");
  await expect(form.getByLabel("Priority")).toHaveValue("2");
  await expect(form.getByLabel("Words to look for")).toHaveValue("interview");
  await save(form);
  await expect.poll(() => names(group(page, 2))).toEqual(["Prep before interviews"]);
  await eventually(
    () => week(cal),
    (l) => expect(spans(l, "Prep before interviews")).toEqual([`${day(1)} 14:45-15:00`]),
  );
  await library();
  await expect(entry("Prep before interviews")).toContainText("Added");

  const renamed = await edit(page, "Prep before interviews");
  await renamed.getByLabel("Title").fill("Interview prep");
  await save(renamed);
  await eventually(
    () => week(cal),
    (l) => {
      expect(spans(l, "Interview prep")).toEqual([`${day(1)} 14:45-15:00`]);
      expect(spans(l, "Prep before interviews")).toEqual([]);
    },
  );
  await library();
  await expect(entry("Prep before interviews")).toContainText("Added");
  await page.reload();
  await expect(entry("Prep before interviews")).toContainText("Added");
  await expect(entry("Daily walk")).not.toContainText("Added");
});
