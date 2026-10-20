// The change log per item (docs/specs/planning-scheduler.md SCH-114 to SCH-119):
// each placement, move and removal the engine makes is logged for its item with
// the old and new times and a reason code from SCH-116.
//
// Ways it can fail, and the check that catches each:
// - a move or removal is not logged, or has no reason   -> entries with data-reason
// - the reason is wrong (a busy event took the time)    -> "no-space-fixed", not another code
// - one item's log shows another item's entries         -> the task log has only its placement
// - the log is not stored                                -> reload
import type { Page } from "@playwright/test";
import { addDays } from "../../src/shared/time.ts";
import { automation, openAutomations } from "./automation-list-helpers.ts";
import { at, blockUntil, type CalendarDriver, eventually, expect, test } from "./fixtures.ts";
import { addHabit, addTask, titled, W } from "./helpers.ts";

const tue = addDays(W, 1);
const week = (cal: CalendarDriver) => cal.events(at(W, "00:00"), at(addDays(W, 7), "00:00"));

/** Opens the change log of an item; it loads each time it opens. */
async function openLog(page: Page, where: "habit" | "task", name: string) {
  if (where === "habit") await openAutomations(page);
  else await page.getByRole("link", { name: "Tasks" }).click();
  const log = (
    where === "habit" ? automation(page, name) : page.locator(`[data-task-title="${name}"]`)
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
