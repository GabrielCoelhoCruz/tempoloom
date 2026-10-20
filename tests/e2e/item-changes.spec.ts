// The change log per item (docs/specs/planning-scheduler.md SCH-114 to SCH-119):
// each placement, move and removal the engine makes is logged for its item with
// the old and new times and a reason code from SCH-116.
//
// Ways it can fail, and the check that catches each:
// - a move or removal is not logged, or has no reason   -> entries with data-reason
// - the reason is wrong (a busy event took the time)    -> "no-space-fixed", not another code
// - one item's log shows another item's entries         -> the task log has only its placement
// - the log is not stored                                -> reload
// - a period with no event, a kept conflict or a new status is not logged
//                                                        -> "skipped", "conflict" and "status" entries
// - the flexible meeting view has no log                 -> the meeting's entries
import type { Page } from "@playwright/test";
import type { ProviderEvent } from "../../src/server/providers/types.ts";
import { addDays } from "../../src/shared/time.ts";
import { automation, openAutomations } from "./automation-list-helpers.ts";
import { at, blockUntil, type CalendarDriver, eventually, expect, test } from "./fixtures.ts";
import { addHabit, addTask, titled, W } from "./helpers.ts";
import { addMeeting } from "./meeting-helpers.ts";

const tue = addDays(W, 1);
const week = (cal: CalendarDriver) => cal.events(at(W, "00:00"), at(addDays(W, 7), "00:00"));

/** Opens the change log of an item; it loads each time it opens. */
async function openLog(page: Page, where: "habit" | "task" | "meeting", name: string) {
  if (where === "habit") await openAutomations(page);
  else await page.getByRole("link", { name: where === "task" ? "Tasks" : "Meetings" }).click();
  const log = (
    where === "habit" ? automation(page, name) : page.locator(`[data-${where}-title="${name}"]`)
  ).getByTestId("item-changes");
  if ((await log.getAttribute("open")) !== null) await log.locator("summary").click();
  await log.locator("summary").click();
  await expect(log.getByText("Loading…")).toHaveCount(0);
  return log;
}

test("each item keeps a change log of its placements, moves and removals, each with the time and a reason code (SCH-114, SCH-116, SCH-119)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await addHabit(page, {
    title: "Walk",
    ideal: "16:00",
    min: 30,
    max: 30,
    days: ["Tue"],
    noRoom: "Remove that day",
  });
  await eventually(
    () => week(cal),
    (l) => expect(titled(l, "Walk").map((e) => e.start)).toEqual([at(tue, "16:00")]),
  );

  // A task, placed in the same week.
  await addTask(page, { title: "Report", minutes: 60, split: false, due: "" });
  const [report] = titled(
    await eventually(
      () => week(cal),
      (l) => expect(titled(l, "Report")).toHaveLength(1),
    ),
    "Report",
  );
  if (!report) throw new Error("no task chunk");

  // A busy event takes the habit's time: it moves, and the log says why.
  await cal.addEvent({ title: "Review", start: at(tue, "15:00"), end: at(tue, "17:00") });
  const [moved] = titled(
    await eventually(
      () => week(cal),
      (l) => {
        expect(titled(l, "Walk")).toHaveLength(1);
        expect(titled(l, "Walk")[0]?.start).not.toBe(at(tue, "16:00"));
      },
    ),
    "Walk",
  );
  if (!moved) throw new Error("no moved habit");

  let log = await openLog(page, "habit", "Walk");
  const entries = log.getByTestId("item-change");
  await expect(entries.and(page.locator('[data-action="moved"]'))).toHaveCount(1);
  const move = entries.and(page.locator('[data-action="moved"]'));
  await expect(move).toHaveAttribute("data-reason", "no-space-fixed");
  await expect(move).toContainText(`moved · Tue ${tue} 16:00–16:30 → Tue ${tue} `);
  await expect(move).toContainText("other events take that time");

  // The whole week fills up: the habit has no time left and is removed, with the reason.
  await cal.addEvent({
    title: "Offsite",
    start: at(W, "00:00"),
    end: at(addDays(W, 7), "00:00"),
  });
  await eventually(
    () => week(cal),
    (l) => expect(titled(l, "Walk")).toHaveLength(0),
  );
  log = await openLog(page, "habit", "Walk");
  // Entries of the test week's Tuesday, newest first: removed, moved, placed.
  const ours = log.getByTestId("item-change").filter({ hasText: `Tue ${tue} ` });
  await expect(ours).toHaveCount(3);
  await expect(ours.nth(0)).toHaveAttribute("data-action", "removed");
  await expect(ours.nth(0)).toHaveAttribute("data-reason", "no-space-fixed");
  await expect(ours.nth(0)).toContainText(`removed · Tue ${tue} `);
  await expect(ours.nth(1)).toHaveAttribute("data-action", "moved");
  await expect(ours.nth(2)).toHaveAttribute("data-action", "placed");
  await expect(ours.nth(2)).toContainText(`placed · Tue ${tue} 16:00–16:30`);

  // The task has its own log: its placement and its move out of the full week, not the habit's.
  await eventually(
    () => week(cal),
    (l) => expect(titled(l, "Report")).toHaveLength(0),
  );
  const task = await openLog(page, "task", "Report");
  const taskMove = task.getByTestId("item-change").and(page.locator('[data-action="moved"]'));
  await expect(taskMove).toHaveCount(1);
  await expect(taskMove).toHaveAttribute("data-reason", "no-space-fixed");
  await expect(task.getByTestId("item-change").last()).toHaveAttribute("data-action", "placed");
  await expect(task.getByTestId("item-change")).toHaveCount(2);
  await expect(task).not.toContainText("16:00–16:30");

  await page.reload();
  log = await openLog(page, "habit", "Walk");
  await expect(log.getByTestId("item-change").filter({ hasText: `Tue ${tue} ` })).toHaveCount(3);
  await expect(
    log.getByTestId("item-change").and(page.locator('[data-action="moved"]')),
  ).toHaveAttribute("data-reason", "no-space-fixed");
});

/** Waits until the item's log shows an entry with the action that contains the text; returns it. */
async function entry(
  page: Page,
  where: "habit" | "task" | "meeting",
  name: string,
  action: string,
  text: string,
) {
  const pick = (log: Awaited<ReturnType<typeof openLog>>) =>
    log
      .getByTestId("item-change")
      .and(page.locator(`[data-action="${action}"]`))
      .filter({
        hasText: text,
      });
  await expect(async () => {
    await expect(pick(await openLog(page, where, name))).toHaveCount(1, { timeout: 1_000 });
  }).toPass({ timeout: 30_000 });
  return pick(await openLog(page, where, name));
}

test("the change log names a skipped period, a kept conflict and a status change, and shows on the flexible meeting view (SCH-114, SCH-116, SCH-119)", async ({
  page,
  cal,
  signIn,
}) => {
  const wed = addDays(W, 2);
  const thu = addDays(W, 3);
  await blockUntil(cal, W);
  await signIn();
  // A habit that keeps its time as a conflict when its period has no room.
  await addHabit(page, {
    title: "Walk",
    ideal: "16:00",
    min: 30,
    max: 30,
    days: ["Tue"],
    noRoom: "Keep and mark the conflict",
  });
  // A task that cannot end before its due time.
  await addTask(page, { title: "Draft", minutes: 120, split: false, due: `${W}T10:00` });
  // A flexible meeting.
  await addMeeting(page, {
    title: "Sync",
    guests: "dana@example.com",
    idealTime: "11:00",
    days: ["Thu"],
  });
  await eventually(
    () => week(cal),
    (l) => {
      expect(titled(l, "Walk").map((e) => e.start)).toEqual([at(tue, "16:00")]);
      expect(titled(l, "Draft").map((e) => e.start)).toEqual([at(W, "09:00")]);
      expect(titled(l, "Sync").map((e) => e.start)).toEqual([at(thu, "11:00")]);
    },
  );

  // The task's status changes: placed, and some work ends after the due time.
  const late = await entry(page, "task", "Draft", "status", "");
  await expect(late).toHaveAttribute("data-reason", "after-due");
  await expect(late).toContainText("status changed");
  await expect(late).toContainText("some work ends after the due date");

  // The flexible meeting has its log on the meeting view.
  const placed = await entry(page, "meeting", "Sync", "placed", `Thu ${thu} 11:00–`);
  await expect(placed).toContainText("placed");

  // The whole week fills up: the habit keeps its time as a conflict.
  await cal.addEvent({
    title: "Offsite",
    start: at(W, "00:00"),
    end: at(addDays(W, 7), "00:00"),
  });
  const conflict = await entry(page, "habit", "Walk", "conflict", `Tue ${tue} 16:00–16:30`);
  await expect(conflict).toContainText("kept as conflict");
  await expect(conflict).toHaveAttribute("data-reason", "no-space-fixed");
  expect(titled(await week(cal), "Walk").map((e) => e.start)).toEqual([at(tue, "16:00")]);

  // A new habit gets no event in the full week: that period is skipped.
  await addHabit(page, {
    title: "Read",
    ideal: "10:00",
    min: 30,
    max: 30,
    days: ["Wed"],
    noRoom: "Remove that day",
  });
  const skipped = await entry(page, "habit", "Read", "skipped", `period of ${wed}`);
  await expect(skipped).toHaveAttribute("data-reason", "no-space-fixed");
  expect(titled(await week(cal), "Read")).toHaveLength(0);

  await page.reload();
  const shown = async (where: "habit" | "task" | "meeting", name: string, action: string) =>
    (await openLog(page, where, name))
      .getByTestId("item-change")
      .and(page.locator(`[data-action="${action}"]`));
  await expect((await shown("meeting", "Sync", "placed")).filter({ hasText: thu })).toHaveCount(1);
  await expect((await shown("habit", "Read", "skipped")).filter({ hasText: wed })).toHaveCount(1);
  await expect((await shown("habit", "Walk", "conflict")).filter({ hasText: tue })).toHaveCount(1);
  await expect(await shown("task", "Draft", "status")).not.toHaveCount(0);
});

test("a move the report does not explain names its cause: a higher-priority item, a settings change, or a plan that changed around it (SCH-119)", async ({
  page,
  cal,
  signIn,
}) => {
  const wed = addDays(W, 2);
  const thu = addDays(W, 3);
  await blockUntil(cal, W);
  await signIn();
  const habit = { min: 30, max: 30, noRoom: "Remove that day" } as const;
  await addHabit(page, { ...habit, title: "Stretch", ideal: "10:00", days: ["Tue"] });
  await addHabit(page, { ...habit, title: "Walk", ideal: "16:00", days: ["Wed"], level: 4 });
  await addHabit(page, { ...habit, title: "Read", ideal: "10:00", days: ["Thu"] });
  // Habit periods can lend a day to the next; each check looks at one start time.
  const starts = (l: ProviderEvent[], name: string) => titled(l, name).map((e) => e.start);
  await eventually(
    () => week(cal),
    (l) => {
      expect(starts(l, "Stretch")).toContain(at(tue, "10:00"));
      expect(starts(l, "Walk")).toContain(at(wed, "16:00"));
      expect(starts(l, "Read")).toContain(at(thu, "10:00"));
    },
  );

  // rules-changed: the habit's ideal time changes.
  await page.getByRole("link", { name: "Habits" }).click();
  await page.locator('[data-habit-title="Stretch"]').getByRole("button", { name: "Edit" }).click();
  const editor = page.getByTestId("habit-editor");
  await editor.getByLabel("Ideal time").fill("14:00");
  await editor.getByRole("button", { name: "Save habit" }).click();
  await eventually(
    () => week(cal),
    (l) => expect(starts(l, "Stretch")).toContain(at(tue, "14:00")),
  );
  const rules = await entry(page, "habit", "Stretch", "moved", `Tue ${tue} 10:00–10:30 →`);
  await expect(rules).toHaveAttribute("data-reason", "rules-changed");
  await expect(rules).toContainText("its settings changed");

  // no-space-priority: a P1 habit wants Walk's time.
  await addHabit(page, {
    ...habit,
    title: "Run",
    ideal: "16:00",
    days: ["Wed"],
    level: 1,
    defense: "Always busy",
  });
  await eventually(
    () => week(cal),
    (l) => {
      expect(starts(l, "Run")).toContain(at(wed, "16:00"));
      expect(starts(l, "Walk")).not.toContain(at(wed, "16:00"));
    },
  );
  const priority = await entry(page, "habit", "Walk", "moved", `Wed ${wed} 16:00–16:30 →`);
  await expect(priority).toHaveAttribute("data-reason", "no-space-priority");
  await expect(priority).toContainText("higher-priority items take that time");

  // rearranged: an all-day busy event takes Thursday. That is time away, not a
  // timed event or another item over the old time, and the report has no
  // entry when Read finds another day of its period.
  await cal.addAllDay(thu, "Holiday", true);
  await eventually(
    () => week(cal),
    (l) => expect(starts(l, "Read")).not.toContain(at(thu, "10:00")),
  );
  const moved = await entry(page, "habit", "Read", "moved", `Thu ${thu} 10:00–10:30 →`);
  await expect(moved).toHaveAttribute("data-reason", "rearranged");
  await expect(moved).toContainText("the plan changed around it");

  await page.reload();
  for (const [name, reason, day] of [
    ["Stretch", "rules-changed", `Tue ${tue} 10:00`],
    ["Walk", "no-space-priority", `Wed ${wed} 16:00`],
    ["Read", "rearranged", `Thu ${thu} 10:00`],
  ] as const)
    await expect(
      (await openLog(page, "habit", name))
        .getByTestId("item-change")
        .and(page.locator(`[data-action="moved"][data-reason="${reason}"]`))
        .filter({ hasText: day }),
    ).toHaveCount(1);
});
