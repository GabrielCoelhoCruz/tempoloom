// Task calendar per hours set (docs/specs/accounts-connected-calendars.md
// rules 19, 21; AT-6): chunks of a task go to the task calendar of the hours
// set the task uses; other sets keep the main calendar.
//
// Ways it can fail, and the check that catches each:
// - the choice is not offered, not saved, or lost on reload    -> select value after reload
// - chunks ignore the set's task calendar                      -> chunk on "Tasks", not on Work
// - one set's choice leaks to another set                      -> work-hours task stays on Work
import { openSettings } from "./calendar-helpers.ts";
import { BACKEND, blockUntil, eventually, expect, test } from "./fixtures.ts";
import { addTask, allEvents, inHours, titled, W } from "./helpers.ts";

test.skip(BACKEND === "google", "The test adds a second CalDAV calendar.");

test("tasks on personal hours go to that set's task calendar; work-hours tasks stay on the main calendar (rule 21, AT-6)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  const tasks = await cal.newCalendar("Tasks");
  await openSettings(page);
  await page.getByRole("button", { name: "Refresh calendar list" }).click();
  await expect(page.getByTestId("calendar-list")).toContainText("Tasks");
  await page.reload();

  const pick = (kind: string) =>
    page.getByTestId(`hours-${kind}`).getByLabel("Calendar for task chunks");
  await expect(pick("personal")).toHaveValue("");
  await pick("personal").selectOption({ label: "Tasks" });
  await expect(page.getByTestId("settings-message")).toHaveText("Saved");
  await page.reload();
  await expect(pick("personal").locator("option:checked")).toHaveText("Tasks");
  await expect(pick("work")).toHaveValue("");

  await addTask(page, {
    title: "AT-Evening",
    minutes: 60,
    split: false,
    due: "",
    hours: "Personal hours",
  });
  await addTask(page, {
    title: "AT-Day",
    minutes: 60,
    split: false,
    due: "",
    hours: "Work hours",
  });
  const onTasks = await eventually(
    () => allEvents(tasks),
    (l) => expect(titled(l, "AT-Evening")).toHaveLength(1),
  );
  const [chunk] = titled(onTasks, "AT-Evening");
  expect(inHours(chunk?.start ?? 0, chunk?.end ?? 0, "18:00", "22:00")).toBe(true);
  expect(titled(onTasks, "AT-Day")).toHaveLength(0);
  const onWork = await eventually(
    () => allEvents(cal),
    (l) => expect(titled(l, "AT-Day")).toHaveLength(1),
  );
  expect(titled(onWork, "AT-Evening")).toHaveLength(0);

  await page.reload();
  await openSettings(page);
  await expect(pick("personal").locator("option:checked")).toHaveText("Tasks");
  expect(titled(await allEvents(tasks), "AT-Evening")).toHaveLength(1);
});
