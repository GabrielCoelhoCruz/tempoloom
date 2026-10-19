// Preview mode turned on by hand (docs/specs/assistant-preview-mode.md rules 2-4,
// 10, 11): planner drags and automation saves are staged with their calendar
// impact, and nothing reaches the calendar until the user applies them.
//
// Ways this can fail, each covered below:
// - with preview mode on, a drag or an automation save still writes at once;
// - the staged impact does not show in the planner (new, moved, deleted events);
// - turning preview mode off, or a reload, drops the pending changes;
// - apply does not run the staged action, or runs it in a different form
//   (a drag that does not lock, a habit that is not created or not placed);
// - an edit (turning a habit off) is not staged, or its impact is wrong.
import { addDays } from "../../src/shared/time.ts";
import {
  at,
  blockUntil,
  type CalendarDriver,
  eventually,
  expect,
  planNow,
  test,
} from "./fixtures.ts";
import { addHabit, addTask, MIN, openWeek, titled, W, windowFrom, windowTo } from "./helpers.ts";
import { previewPanel, reviewAndApply, stagedRow } from "./preview-helpers.ts";

const weekOf = (cal: CalendarDriver) => cal.events(at(W, "00:00"), at(addDays(W, 7), "00:00"));

test("preview mode turned on by hand stages a drag; turning it off keeps it pending after reload; apply writes it (SPEC-ASSIST-02 rules 3, 10, 11)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await addTask(page, { title: "PV-Drag", minutes: 60, split: false });
  const [chunk] = titled(
    await eventually(
      () => cal.events(windowFrom(), windowTo()),
      (evs) => expect(titled(evs, "PV-Drag")).toHaveLength(1),
    ),
    "PV-Drag",
  );
  if (!chunk) throw new Error("no chunk");
  await openWeek(page);
  const panel = previewPanel(page);
  await expect(panel.getByLabel("Preview mode")).not.toBeChecked();
  await panel.getByLabel("Preview mode").check();
  await expect(panel).toContainText("Changes you make now are staged");

  // Drag the chunk down 2 hours (48 px per hour).
  const box = page.locator(".ev-task", { hasText: "PV-Drag" }).first();
  const b = await box.boundingBox();
  if (!b) throw new Error("no box");
  await page.mouse.move(b.x + b.width / 2, b.y + 5);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + 5 + 48, { steps: 4 });
  await page.mouse.move(b.x + b.width / 2, b.y + 5 + 96, { steps: 4 });
  await page.mouse.up();
  await expect(stagedRow(page, "PV-Drag")).toContainText("Your edit");
  await expect(page.locator(".ev-staged-new", { hasText: "PV-Drag" })).toBeVisible();
  await expect(page.locator(".ev-staged-from", { hasText: "PV-Drag" })).toBeVisible();
  await planNow(page);
  expect(titled(await cal.events(windowFrom(), windowTo()), "PV-Drag")[0]?.start).toBe(chunk.start);

  // Off: the change stays pending, the overlay goes, and both survive a reload.
  await panel.getByLabel("Preview mode").uncheck();
  await expect(page.getByTestId("preview-pending")).toContainText("1 staged change is pending");
  await expect(page.locator(".ev-staged-new")).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("preview-pending")).toContainText("1 staged change is pending");
  await expect(panel.getByLabel("Preview mode")).not.toBeChecked();
  expect(titled(await cal.events(windowFrom(), windowTo()), "PV-Drag")[0]?.start).toBe(chunk.start);

  await panel.getByLabel("Preview mode").check();
  await expect(stagedRow(page, "PV-Drag")).toBeVisible();
  await reviewAndApply(page);
  await expect(page.getByTestId("apply-summary")).toContainText("Applied 1");
  const target = chunk.start + 2 * 60 * MIN;
  const [moved] = titled(
    await eventually(
      () => cal.events(windowFrom(), windowTo()),
      (evs) => expect(titled(evs, "PV-Drag")[0]?.start).toBe(target),
    ),
    "PV-Drag",
  );
  expect(moved?.summary.startsWith("🔒")).toBe(true);
  await page.reload();
  await expect(panel.getByTestId("staged-change")).toHaveCount(0);
  // Turned on by hand, preview mode stays on until the user turns it off.
  await expect(panel.getByLabel("Preview mode")).toBeChecked();
});

test("with preview mode on, a new habit shows its calendar impact and writes nothing until apply; turning it off is staged too (SPEC-ASSIST-02 rule 2, T6)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await openWeek(page);
  await previewPanel(page).getByLabel("Preview mode").check();
  await expect(previewPanel(page)).toContainText("Changes you make now are staged");

  await addHabit(page, { title: "Walk", ideal: "16:00", min: 30, max: 30, staged: true });
  const banner = page.getByTestId("preview-banner");
  await expect(banner).toContainText("1 staged change");
  await expect(page.locator('[data-habit-title="Walk"]')).toHaveCount(0);
  await page.reload();
  await expect(page.locator('[data-habit-title="Walk"]')).toHaveCount(0);

  await banner.getByRole("link", { name: "Review in the planner" }).click();
  await openWeek(page);
  const row = stagedRow(page, "Walk");
  await expect(row).toContainText("Automation edit");
  await expect(row).toContainText("New habit");
  await expect(row).toContainText("creates");
  await expect(page.locator(".ev-staged-new", { hasText: "Walk" })).toHaveCount(5);
  await planNow(page);
  expect(titled(await weekOf(cal), "Walk")).toHaveLength(0);

  await reviewAndApply(page);
  await expect(page.getByTestId("apply-summary")).toContainText("Applied 1");
  const placed = await eventually(
    () => weekOf(cal),
    (evs) => expect(titled(evs, "Walk")).toHaveLength(5),
  );
  for (const e of titled(placed, "Walk")) expect(e.end - e.start).toBe(30 * MIN);
  await page.reload();
  await expect(page.locator(".ev-habit", { hasText: "Walk" })).toHaveCount(5);
  await expect(page.locator(".ev-staged-new")).toHaveCount(0);

  // An edit: turning the habit off is staged; its events show as deleted until apply.
  await page.getByRole("link", { name: "Habits" }).click();
  await page.locator('[data-habit-title="Walk"]').getByRole("button", { name: "Turn off" }).click();
  await expect(page.getByTestId("preview-banner")).toContainText("1 staged change");
  // Still on: the button still offers to turn it off.
  await expect(
    page.locator('[data-habit-title="Walk"]').getByRole("button", { name: "Turn off" }),
  ).toBeVisible();
  await openWeek(page);
  await expect(stagedRow(page, "Walk")).toContainText("Edit habit");
  await expect(page.locator(".ev-staged-deleted", { hasText: "Walk" })).toHaveCount(5);
  await planNow(page);
  expect(titled(await weekOf(cal), "Walk")).toHaveLength(5);
  await reviewAndApply(page);
  await expect(page.getByTestId("apply-summary")).toContainText("Applied 1");
  await eventually(
    () => weekOf(cal),
    (evs) => expect(titled(evs, "Walk")).toHaveLength(0),
  );
  await page.getByRole("link", { name: "Habits" }).click();
  await expect(
    page.locator('[data-habit-title="Walk"]').getByRole("button", { name: "Turn on" }),
  ).toBeVisible();
});
