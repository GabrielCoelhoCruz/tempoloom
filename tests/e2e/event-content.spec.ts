// Managed event descriptions: markdown notes, app links, the link to the item
// in the planner, and the timer link in focus and habit descriptions
// (docs/specs/planning-event-content.md CNT-10 to CNT-14, AT-C1;
// docs/specs/tools-pomodoro-timer.md rule 19, T5).
//
// Ways it can fail, and the check that catches each:
// - the calendar gets rewritten or escaped markdown                  -> exact text on Radicale
// - the planner shows raw markdown, or a link that does not work      -> <strong>, <a href>
// - an app link (obsidian://) is dropped or not clickable             -> <a href="obsidian://...">
// - a javascript: link or a file: image becomes active                -> plain text, no <img>
// - checklist items lose their state                                  -> checked boxes
// - the planner link is missing or opens nothing                      -> description URL, drawer
// - the focus description never reaches the focus events             -> every focus event on Radicale
// - a habit's notes (timer link) miss some of its events              -> every habit event on Radicale
// - a reload loses the description or the rendering                   -> reload checks
import type { Page } from "@playwright/test";
import { addDays } from "../../src/shared/time.ts";
import { at, blockUntil, eventually, expect, test } from "./fixtures.ts";
import { addHabit, addTask, allEvents, openEvent, openWeek, titled, W } from "./helpers.ts";

const NOTES = [
  "**Plan** see [doc](https://example.com/doc)",
  "## Steps",
  "- [ ] draft",
  "- [x] outline",
  "1. first",
  "2. second",
  "[Open note](obsidian://open?vault=work&file=plan)",
  "[bad](javascript:alert(1))",
  "![chart](https://example.com/chart.png)",
  "![local](file:///etc/passwd)",
].join("\n");

async function checkRendered(page: Page) {
  const notes = page.getByTestId("event-notes");
  await expect(notes.locator("strong", { hasText: "Plan" })).toBeVisible();
  await expect(notes.getByRole("link", { name: "doc" })).toHaveAttribute(
    "href",
    "https://example.com/doc",
  );
  await expect(notes.getByRole("heading", { name: "Steps" })).toBeVisible();
  await expect(notes.getByRole("checkbox", { name: "draft" })).not.toBeChecked();
  await expect(notes.getByRole("checkbox", { name: "outline" })).toBeChecked();
  await expect(notes.locator("ol li")).toHaveText(["first", "second"]);
  await expect(notes.getByRole("link", { name: "Open note" })).toHaveAttribute(
    "href",
    "obsidian://open?vault=work&file=plan",
  );
  await expect(notes.getByRole("link", { name: "bad" })).toHaveCount(0);
  await expect(notes).toContainText("[bad](javascript:alert(1))");
  await expect(notes.locator('img[alt="chart"]')).toHaveAttribute(
    "src",
    "https://example.com/chart.png",
  );
  await expect(notes.locator('img[alt="local"]')).toHaveCount(0);
}

test("task notes keep their markdown in the calendar, render in the planner and link back to the task (CNT-10 to CNT-14, AT-C1)", async ({
  page,
  app,
  cal,
  signIn,
}) => {
  await page.route("https://example.com/**", (r) =>
    r.fulfill({ status: 200, contentType: "image/png", body: "" }),
  );
  await blockUntil(cal, W);
  await signIn();
  await addTask(page, { title: "AT-C1", minutes: 60, split: false, due: "", notes: NOTES });
  const [task] = app.query<{ id: string }>("SELECT id FROM tasks WHERE title = 'AT-C1'");
  const link = `${app.baseUrl}/?item=task:${task?.id}`;
  const [chunk] = titled(
    await eventually(
      () => allEvents(cal),
      (l) => expect(titled(l, "AT-C1")[0]?.description).toContain(link),
    ),
    "AT-C1",
  );
  // CNT-13: the calendar holds the markdown as written, then the planner link.
  expect(chunk?.description.startsWith(NOTES)).toBe(true);

  await openWeek(page);
  await openEvent(page, "AT-C1");
  await checkRendered(page);
  await page.reload();
  await openEvent(page, "AT-C1");
  await checkRendered(page);

  // The link in the calendar opens the task's event in the planner.
  await page.goto(link.replace(app.baseUrl, ""));
  await expect(page.getByTestId("event-drawer").getByRole("heading")).toHaveText("AT-C1");
  await expect(page.getByTestId("week-label")).toContainText(W);
});

test("a timer link in the focus time description and in habit notes reaches every event (tools-pomodoro-timer rule 19, T5)", async ({
  page,
  app,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  const timer = `${app.baseUrl}/tools/pomodoro`;
  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Protect 10 hours of focus time per week" }).click();
  const focusRow = page.locator('[data-focus-title="Focus time"]');
  await focusRow.getByLabel("Description").fill(`[Pomodoro timer](${timer})`);
  await focusRow.getByRole("button", { name: "Save description" }).click();
  await expect(page.getByTestId("settings-message")).toHaveText("Saved");

  await addHabit(page, {
    title: "AT-Pomo habit",
    ideal: "16:00",
    min: 30,
    max: 30,
    days: ["Tue", "Thu"],
    notes: `Use the timer: ${timer}`,
  });
  const evs = await eventually(
    () => allEvents(cal),
    (l) => {
      const focus = titled(l, "Focus time").filter((e) => e.start >= at(W, "00:00"));
      expect(focus.length).toBeGreaterThan(1);
      for (const e of focus) expect(e.description).toContain(timer);
      const habit = titled(l, "AT-Pomo habit");
      expect(habit.length).toBeGreaterThan(1);
      for (const e of habit) expect(e.description).toContain(timer);
    },
  );
  const [habit] = app.query<{ id: string }>("SELECT id FROM habits WHERE title = 'AT-Pomo habit'");
  for (const e of titled(evs, "AT-Pomo habit"))
    expect(e.description).toContain(`/?item=habit:${habit?.id}`);

  await openWeek(page);
  await openEvent(page, "Focus time");
  const notes = page.getByTestId("event-notes");
  await expect(notes.getByRole("link", { name: "Pomodoro timer" })).toHaveAttribute("href", timer);

  await page.reload();
  await page.getByRole("link", { name: "Settings" }).click();
  await expect(
    page.locator('[data-focus-title="Focus time"]').getByLabel("Description"),
  ).toHaveValue(`[Pomodoro timer](${timer})`);
  await openWeek(page, addDays(W, 0));
  await openEvent(page, "AT-Pomo habit");
  await expect(page.getByTestId("event-notes")).toContainText(timer);
});
