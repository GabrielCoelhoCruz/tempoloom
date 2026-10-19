// Focus time behavior (docs/specs/focus-time.md rules 1-10, 23, 24, 35,
// Outputs; planning-next-up.md NXT-40 to NXT-44, AT 6): proactive and
// reactive modes, weekly progress and the "goal not reached" notice,
// auto-decline with a message, and one task list on every focus event.
//
// Ways it can fail, and the check that catches each:
// - proactive mode ignores the daily limit or the free time        -> minutes per day
// - the planner shows no progress, a wrong total, or no notice when the goal
//   is short                                                       -> progress text
// - the notice stays after the goal is reached                    -> no notice
// - reactive mode places focus while plenty of free time is left    -> no focus events
// - reactive mode does not turn the last free time into focus      -> minutes per day
// - the mode is not saved                                          -> select value after reload
// - focus time declines invitations while auto-decline is off      -> answers stay unanswered
// - auto-decline misses an invitation over focus time, declines one outside it,
//   or sends no message                                            -> PARTSTAT and COMMENT on the server
// - a declined invitation moves the focus event                    -> same focus events
// - the decline flips back on a later run                          -> answer after more runs
// - focus events show different task lists, or the search is a snapshot
//                                                                  -> two events, same list
// - assigning a search changes focus events                        -> same events
// - the planner does not list the tasks while focus runs           -> current panel

import {
  boxOf,
  day,
  invite,
  minutesOf,
  moveToNow,
  newTaskSearch,
  openSettings,
  rawEvent,
  span,
  week,
} from "./automation-helpers.ts";
import { at, BACKEND, blockUntil, eventually, expect, local, test } from "./fixtures.ts";
import { addTask, openWeek, titled, W } from "./helpers.ts";

test.skip(BACKEND === "google", "These scenarios use invitations and CalDAV reads.");

const perDay = (evs: { start: number; end: number }[]) => {
  const out: Record<string, number> = {};
  for (const e of evs) {
    const d = local(e.start).slice(0, 10);
    out[d] = (out[d] ?? 0) + (e.end - e.start) / 60_000;
  }
  return out;
};

test("proactive focus stops at the daily limit and shows the goal is not reached; reactive protects free time only when it runs short (rules 1-10, 35; Outputs)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  // Monday to Wednesday are full, Thursday has two free hours: 10 free hours in the week.
  await cal.addEvent({ title: "Workshop", start: at(day(0), "09:00"), end: at(day(0), "17:00") });
  await cal.addEvent({ title: "Workshop", start: at(day(1), "09:00"), end: at(day(1), "17:00") });
  const wednesday = await cal.addEvent({
    title: "Workshop",
    start: at(day(2), "09:00"),
    end: at(day(2), "17:00"),
  });
  await cal.addEvent({ title: "Workshop", start: at(day(3), "09:00"), end: at(day(3), "15:00") });
  await signIn();
  await openSettings(page);
  await page.getByRole("button", { name: "Protect 10 hours of focus time per week" }).click();
  // Proactive: at most 4 hours a day, so Thursday gets 2 and Friday 4.
  await eventually(
    () => week(cal),
    (l) => expect(perDay(titled(l, "Focus time"))).toEqual({ [day(3)]: 120, [day(4)]: 240 }),
  );
  await openWeek(page);
  const progress = page.getByTestId("focus-progress");
  await expect(progress).toContainText("Focus time: 6 h of 10 h this week");
  await expect(progress).toContainText("Goal not reached: 4 h missing");

  await openSettings(page);
  const options = page.getByTestId("focus-options");
  await options.getByLabel("Mode").selectOption({ label: "Reactive" });
  await options.getByRole("button", { name: "Save focus options" }).click();
  await expect(page.getByTestId("focus-options-message")).toHaveText("Saved");
  // The free time left (10 h) is not more than the missing goal: all of it becomes focus.
  await eventually(
    () => week(cal),
    (l) => expect(perDay(titled(l, "Focus time"))).toEqual({ [day(3)]: 120, [day(4)]: 480 }),
  );
  await openWeek(page);
  await expect(progress).toContainText("Focus time: 10 h of 10 h this week");
  await expect(progress).not.toContainText("Goal not reached");

  // Wednesday frees up: 18 free hours are more than the goal, so reactive mode waits.
  await cal.remove(wednesday);
  await eventually(
    () => week(cal),
    (l) => expect(titled(l, "Focus time")).toHaveLength(0),
  );
  await page.reload();
  await expect(progress).toContainText("Focus time: 0 h of 10 h this week");
  await expect(progress).not.toContainText("Goal not reached");
  await openSettings(page);
  await expect(options.getByLabel("Mode")).toHaveValue("reactive");
});

test("auto-decline declines unanswered invitations over focus time with the message; the focus event stays (rule 23; AT 8)", async ({
  page,
  cal,
  radicale,
  signIn,
}) => {
  if (!radicale) throw new Error("CalDAV only");
  await blockUntil(cal, W);
  await signIn();
  await openSettings(page);
  await page.getByRole("button", { name: "Protect 10 hours of focus time per week" }).click();
  const evs = await eventually(
    () => week(cal),
    (l) => expect(minutesOf(titled(l, "Focus time"))).toBe(600),
  );
  const focus = titled(evs, "Focus time").map(span);
  const [first] = titled(evs, "Focus time");
  if (!first) throw new Error("no focus event");
  const start = local(first.start);
  const over = await invite(
    cal,
    "Vendor pitch",
    start.slice(0, 10),
    start.slice(11),
    local(first.start + 30 * 60_000).slice(11),
  );
  // Friday afternoon holds no focus time.
  const outside = await invite(cal, "Lunch talk", day(4), "15:00", "15:30");
  const answers = async () => {
    const l = await week(cal);
    return [over, outside].map((id) => l.find((e) => e.id === id)?.selfResponse);
  };
  // Auto-decline is off: nothing is declined; the busy focus event alone protects the time.
  await page.waitForTimeout(11_000);
  expect(await answers()).toEqual(["needsAction", "needsAction"]);

  const options = page.getByTestId("focus-options");
  await options.getByLabel("Decline invitations that overlap focus time").check();
  await options.getByLabel("Decline message").fill("In focus");
  await options.getByRole("button", { name: "Save focus options" }).click();
  await expect(page.getByTestId("focus-options-message")).toHaveText("Saved");
  await eventually(answers, (a) => expect(a).toEqual(["declined", "needsAction"]));
  const raw = await rawEvent(radicale, over);
  expect(raw).toMatch(/ATTENDEE;[^\n]*PARTSTAT=DECLINED[^\n]*mailto:e2e@tempoloom\.test/i);
  expect(raw).toContain("COMMENT:In focus");
  // The focus events did not move, and later runs keep the answers.
  await page.waitForTimeout(11_000);
  expect(await answers()).toEqual(["declined", "needsAction"]);
  expect(titled(await week(cal), "Focus time").map(span)).toEqual(focus);
  await page.reload();
  await expect(options.getByLabel("Decline invitations that overlap focus time")).toBeChecked();
  await expect(options.getByLabel("Decline message")).toHaveValue("In focus");
});

test("focus time carries one task search: every focus event lists the same tasks, and the planner shows them while focus runs (rule 24; NXT-40 to NXT-44, AT 6)", async ({
  page,
  app,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await addTask(page, { title: "Report Q3", minutes: 30, split: false, due: "", level: 4 });
  await addTask(page, { title: "Email vendor", minutes: 30, split: false, due: "", level: 4 });
  await openSettings(page);
  await page.getByRole("button", { name: "Protect 10 hours of focus time per week" }).click();
  // The two 30-minute work tasks are counted time, so focus fills 9 of the 10 hours.
  const before = await eventually(
    () => week(cal),
    (l) => expect(minutesOf(titled(l, "Focus time"))).toBe(540),
  );
  const options = page.getByTestId("focus-options");
  await newTaskSearch(options, "Reports", "report");
  await options.getByRole("button", { name: "Save focus options" }).click();
  await expect(page.getByTestId("focus-options-message")).toHaveText("Saved");

  const blocks = titled(before, "Focus time");
  const first = blocks[0];
  const last = blocks.at(-1);
  if (!first || !last || local(first.start).slice(0, 10) === local(last.start).slice(0, 10)) {
    throw new Error("expected focus events on two days");
  }
  await openWeek(page);
  const search = page.getByTestId("event-task-search");
  for (const e of [first, last]) {
    await (await boxOf(page, app, e.id)).click();
    await expect(search.getByLabel("Task search").locator("option:checked")).toHaveText("Reports");
    await expect(search.getByTestId("search-tasks").locator("[data-task]")).toHaveText([
      "Report Q3",
    ]);
    await page.getByTestId("event-drawer").getByRole("button", { name: "Close" }).click();
  }
  // The assignment changes no focus event.
  expect(
    titled(await week(cal), "Focus time").map((e) => [e.id, span(e), e.summary, e.description]),
  ).toEqual(blocks.map((e) => [e.id, span(e), e.summary, e.description]));

  // While a focus event runs, the planner lists the tasks of the search.
  await moveToNow(cal, first);
  await page.goto("/");
  const panel = page.getByTestId("current-tasks");
  await expect(panel).toContainText("Focus time", { timeout: 30_000 });
  await expect(panel.locator("[data-task]")).toHaveText(["Report Q3"]);
  await addTask(page, { title: "Report Q4", minutes: 30, split: false, due: "", level: 4 });
  await page.goto("/");
  await expect(panel.locator("[data-task]")).toHaveText(["Report Q3", "Report Q4"]);
  await page.reload();
  await expect(panel.locator("[data-task]")).toHaveText(["Report Q3", "Report Q4"]);
});
