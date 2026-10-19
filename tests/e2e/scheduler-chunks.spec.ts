// Chunk sizes that leave no valid split (docs/specs/planning-tasks.md TSK-10,
// TSK-12, TSK-13): with shortest chunk = longest chunk = 60 minutes, 90 or
// 150 minutes cannot split into 60-minute chunks. The scheduler places the
// 60-minute chunks and then the rest as one short last chunk. When a split
// exists (ceil(need / longest) * shortest <= need), no chunk is short: 195
// minutes with 60-90 minute chunks gets 75, 60 and 60.
//
// Ways it can fail, and the check that catches each:
// - the task is not placed at all and shows "no free time"  -> Radicale total, task-issue
// - the rest is dropped (only whole 60-minute chunks)       -> Radicale total
// - a chunk breaks the longest chunk (a 90-minute chunk)    -> chunk lengths
// - a short chunk although a split exists (90, 90, 15)      -> chunk lengths
// - the result is lost on reload                            -> state after reload
import type { Page } from "@playwright/test";
import type { CalendarDriver } from "./fixtures.ts";
import { eventually, expect, test } from "./fixtures.ts";
import { addTask, allEvents, MIN, titled } from "./helpers.ts";

async function expectChunks(page: Page, cal: CalendarDriver, title: string, want: number[]) {
  const total = want.reduce((a, b) => a + b, 0);
  const evs = await eventually(
    () => allEvents(cal),
    (l) => expect(titled(l, title).reduce((a, e) => a + (e.end - e.start), 0)).toBe(total * MIN),
  );
  const lengths = titled(evs, title)
    .map((e) => (e.end - e.start) / MIN)
    .sort((a, b) => b - a);
  expect(lengths).toEqual(want);
  const row = page.locator(`[data-task-title="${title}"]`);
  await expect(row.getByTestId("task-state")).toHaveText("scheduled");
  await expect(row.getByTestId("task-issue")).toHaveCount(0);
}

test("a 90-minute task with 60-minute chunks gets 60 and 30 minutes, not no free time (TSK-13)", async ({
  page,
  cal,
  signIn,
}) => {
  await signIn();
  await addTask(page, { title: "AT-Ninety", minutes: 90, min: 60, max: 60, due: "" });
  await expectChunks(page, cal, "AT-Ninety", [60, 30]);
  await page.reload();
  const row = page.locator('[data-task-title="AT-Ninety"]');
  await expect(row.getByTestId("task-left")).toHaveText("1 h 30 min left");
  await expect(row.getByTestId("task-state")).toHaveText("scheduled");
  await expect(row.getByTestId("task-issue")).toHaveCount(0);
});

test("+30 min on a 120-minute task with 60-minute chunks places 60, 60 and 30 minutes (TSK-13)", async ({
  page,
  cal,
  signIn,
}) => {
  await signIn();
  await addTask(page, { title: "AT-Plus", minutes: 120, min: 60, max: 60, due: "" });
  await expectChunks(page, cal, "AT-Plus", [60, 60]);
  await page
    .locator('[data-task-title="AT-Plus"]')
    .getByRole("button", { name: "+30 min" })
    .click();
  await expectChunks(page, cal, "AT-Plus", [60, 60, 30]);
  await page.reload();
  const row = page.locator('[data-task-title="AT-Plus"]');
  await expect(row.getByTestId("task-left")).toHaveText("2 h 30 min left");
  await expect(row.getByTestId("task-issue")).toHaveCount(0);
  await expectChunks(page, cal, "AT-Plus", [60, 60, 30]);
});

test("a 195-minute task with 60-90 minute chunks gets 75, 60 and 60 minutes, no short chunk (TSK-10, TSK-13)", async ({
  page,
  cal,
  signIn,
}) => {
  // A split exists (3 x 60 <= 195), so no chunk may be shorter than 60.
  // Longest chunks first would give 90, 90 and 15.
  await signIn();
  await addTask(page, { title: "AT-Split", minutes: 195, min: 60, max: 90, due: "" });
  await expectChunks(page, cal, "AT-Split", [75, 60, 60]);
  await page.reload();
  await expect(page.locator('[data-task-title="AT-Split"]').getByTestId("task-left")).toHaveText(
    "3 h 15 min left",
  );
  await expectChunks(page, cal, "AT-Split", [75, 60, 60]);
});
