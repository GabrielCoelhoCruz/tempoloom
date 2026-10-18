// Public tools and personal stats.
import { addDays } from "../../src/shared/time.ts";
import { at, BACKEND, blockUntil, eventually, expect, test } from "./fixtures.ts";
import { addHabit, addTask, allEvents, titled, W } from "./helpers.ts";

test("the meeting cost calculator computes, rejects bad input and resets (tools-meeting-cost-calculator rules 1-6)", async ({
  page,
  app,
}) => {
  expect(app.baseUrl).toContain("localhost");
  await page.goto("/tools/meeting-cost");
  await expect(page.getByTestId("cost-per-meeting")).toHaveText("$0");
  await page.getByRole("button", { name: "Calculate" }).click();
  // 5 people × 100000/1920 per hour × 0.5 h = 130.21; weekly = 48 times a year.
  await expect(page.getByTestId("cost-per-meeting")).toHaveText("$130");
  await expect(page.getByTestId("cost-annual")).toHaveText("$6,250");
  await page.getByLabel("How often").selectOption("every_weekday");
  await page.getByRole("button", { name: "Calculate" }).click();
  await expect(page.getByTestId("cost-annual")).toHaveText("$31,250");
  await page.getByLabel("Attendees").fill("0");
  await page.getByRole("button", { name: "Calculate" }).click();
  await expect(page.getByText("Enter a number above 0.")).toBeVisible();
  await page.getByRole("button", { name: "Reset" }).click();
  await expect(page.getByTestId("cost-annual")).toHaveText("$0");
  await expect(page.getByLabel("Attendees")).toHaveValue("5");
});

test("the pomodoro timer runs sessions and breaks, counts them and keeps them after reload (tools-pomodoro-timer)", async ({
  page,
  app,
}) => {
  expect(app.baseUrl).toContain("localhost");
  await page.clock.install({ time: new Date("2026-11-09T09:00:00") });
  await page.goto("/tools/pomodoro");
  await expect(page.getByTestId("timer")).toHaveText("25 00");
  await page.getByRole("button", { name: "Start" }).click();
  await page.clock.fastForward("10:00");
  await expect(page.getByTestId("timer")).toHaveText("15 00");
  await expect(page).toHaveTitle(/15:00 · Work session/);
  await page.clock.fastForward("15:01");
  await expect(page.getByRole("tab", { name: "Short break" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByTestId("timer")).toHaveText("05 00");
  await expect(page.getByTestId("to-long")).toHaveText("Sessions to long break 1/4");
  await expect(page.getByTestId("count-today")).toHaveText("Today 1");
  // One-minute sessions with auto-start: after the fourth session comes a long break.
  await page.getByRole("button", { name: "Settings" }).click();
  const settings = page.getByTestId("timer-settings");
  await settings.getByLabel("Work session (minutes)").fill("1");
  await settings.getByLabel("Short break (minutes)").fill("1");
  await settings.getByLabel("Start the next phase on its own").check();
  await page.getByRole("tab", { name: "Work session" }).click();
  await page.getByRole("button", { name: "Start" }).click();
  // runFor fires every timer in order, also the ones each new phase sets.
  await page.clock.runFor("06:06");
  await expect(page.getByRole("tab", { name: "Long break" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByTestId("count-today")).toHaveText("Today 4");
  // Tasks in the timer.
  await page.getByLabel("New task").fill("Draft the agenda");
  await page.getByRole("button", { name: "Add task" }).click();
  await page.getByTestId("timer-tasks").getByRole("checkbox").check();
  await expect(page.getByTestId("timer-stats")).toContainText("1 tasks done");
  await page.reload();
  await expect(page.getByTestId("count-today")).toHaveText("Today 4");
  await expect(page.getByTestId("timer-tasks")).toContainText("Draft the agenda");
});

test("stats sum meetings, tasks and habits for a chosen range (analytics-personal-stats rules 1-9)", async ({
  page,
  cal,
  signIn,
}) => {
  test.skip(BACKEND === "google", "Meetings with attendees need CalDAV in this suite.");
  await blockUntil(cal, W);
  const tue = addDays(W, 1);
  await cal.addEvent({
    title: "1:1",
    start: at(tue, "14:00"),
    end: at(tue, "15:00"),
    attendees: ["a@example.com"],
  });
  await cal.addEvent({
    title: "Team sync",
    start: at(tue, "15:00"),
    end: at(tue, "15:30"),
    attendees: ["a@example.com", "b@example.com"],
  });
  await cal.addEvent({
    title: "Late call",
    start: at(tue, "19:00"),
    end: at(tue, "19:30"),
    attendees: ["c@example.com"],
  });
  await signIn();
  await addTask(page, { title: "AT-Stats", minutes: 120, split: false, due: "" });
  await addHabit(page, { title: "Inbox", ideal: "16:00", min: 30, max: 30 });
  await eventually(
    () => allEvents(cal),
    (l) => {
      expect(titled(l, "AT-Stats")).toHaveLength(1);
      const inW = titled(l, "Inbox").filter(
        (e) => e.start >= at(W, "00:00") && e.start < at(addDays(W, 5), "00:00"),
      );
      expect(inW).toHaveLength(5);
    },
  );
  await page.getByRole("link", { name: "Stats" }).click();
  await page.getByLabel("From").fill(W);
  await page.getByLabel("To").fill(addDays(W, 6));
  await expect(page.getByTestId("stat-oneOnOne")).toHaveText("1 h 30 min");
  await expect(page.getByTestId("stat-groupMeetings")).toHaveText("30 min");
  await expect(page.getByTestId("stat-tasks")).toHaveText("2 h");
  await expect(page.getByTestId("stat-workHabits")).toHaveText("2 h 30 min");
  await expect(page.getByTestId("hl-meetings")).toHaveText("2 h");
  await expect(page.getByTestId("hl-outside")).toHaveText("30 min");
  await page.getByLabel("Group by").selectOption("week");
  await expect(page.getByTestId("trend").locator(".trend-col")).toHaveCount(1);
  await page.reload();
  await expect(page.getByTestId("stats-page")).toBeVisible();
});
