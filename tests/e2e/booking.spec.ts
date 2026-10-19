// Booking links: page setup, public booking without sign-in, priority, limits,
// hidden links, reschedule and cancel. Specs: booking-links*.md.
import { addDays } from "../../src/shared/time.ts";
import { at, blockUntil, eventually, expect, local, test } from "./fixtures.ts";
import {
  addHabit,
  addLink,
  addTask,
  allEvents,
  book,
  claimPage,
  openWeek,
  slot,
  titled,
  visitor,
  W,
} from "./helpers.ts";

const day = (n: number) => addDays(W, n);

test("a visitor books a time without signing in; the event lands on the calendar and a task moves away (booking-links rules 10-13, 22-23)", async ({
  page,
  browser,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await addTask(page, { title: "AT-Movable", minutes: 60, split: false, due: "", level: 4 });
  await eventually(
    () => allEvents(cal),
    (l) => expect(local(titled(l, "AT-Movable")[0]?.start ?? 0)).toBe(`${W} 09:00`),
  );
  await claimPage(page, "ada");
  await expect(page.getByTestId("link-row")).toHaveCount(3);
  await addLink(page, { title: "Intro call", durations: "30", level: 2 });

  const v = await visitor(browser);
  await v.goto("/book/ada");
  await expect(v.getByTestId("public-page")).toContainText("Intro call");
  await v.getByTestId("public-link").filter({ hasText: "Intro call" }).click();
  await expect(v.getByTestId("booking-page")).toContainText("Intro call");
  await expect(slot(v, at(W, "09:00"))).toBeVisible();
  // The blocker before W leaves no earlier times.
  const first = await v
    .locator('[data-testid="times"] button[data-start]')
    .first()
    .getAttribute("data-start");
  expect(Number(first)).toBe(at(W, "09:00"));
  await book(v, at(W, "09:00"), "Bea Booker", "bea@example.com");

  const evs = await eventually(
    () => allEvents(cal),
    (l) => {
      const booked = l.find((e) => e.summary === "Intro call with Bea Booker");
      expect(booked && local(booked.start)).toBe(`${W} 09:00`);
      const [task] = titled(l, "AT-Movable");
      expect(task && local(task.start)).not.toBe(`${W} 09:00`);
    },
  );
  const booked = evs.find((e) => e.summary === "Intro call with Bea Booker");
  expect(booked?.busy).toBe(true);
  expect(booked?.attendeeCount).toBeGreaterThanOrEqual(1);
  expect(booked?.description).toContain("/book/manage/");
  // The same time is no longer offered; the owner sees the booking after a reload.
  await v.goto("/book/ada/intro-call");
  await expect(v.getByTestId("times")).toBeVisible();
  await expect(slot(v, at(W, "09:00"))).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("booking-list")).toContainText("Bea Booker");
  // The booked meeting stays P1, and the planner says why.
  await openWeek(page);
  await page.locator(".ev-external", { hasText: "Intro call with Bea Booker" }).click();
  const fixed = page.getByTestId("external-priority-fixed");
  await expect(fixed.getByLabel("Priority for booking links")).toBeDisabled();
  await expect(fixed).toContainText("Meetings booked through a booking link stay P1");
});

test("link priority decides which managed time it offers (availability rule 12)", async ({
  page,
  browser,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await addHabit(page, {
    title: "Standup prep",
    ideal: "09:00",
    min: 60,
    max: 60,
    level: 3,
    days: ["Mon"],
    defense: "Always busy",
  });
  await eventually(
    () => cal.events(at(W, "00:00"), at(day(1), "00:00")),
    (l) => expect(local(titled(l, "Standup prep")[0]?.start ?? 0)).toBe(`${W} 09:00`),
  );
  await claimPage(page, "cleo");
  const v = await visitor(browser);
  // "Important meeting" is P1: it may book over the P3 habit.
  await v.goto("/book/cleo/important-meeting");
  await expect(slot(v, at(W, "09:00"))).toBeVisible();
  // "Quick meeting" is P3: the P3 habit blocks it.
  await v.goto("/book/cleo/quick-meeting");
  await expect(v.getByTestId("times")).toBeVisible();
  await expect(slot(v, at(W, "09:00"))).toHaveCount(0);
  await expect(slot(v, at(W, "10:00"))).toBeVisible();
});

test("a daily limit closes the day after one booking; a hidden link is unlisted but works (rules 6, 9)", async ({
  page,
  browser,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await claimPage(page, "dora");
  await addLink(page, { title: "Once a day", durations: "30", maxPerDay: 1, hidden: true });
  const v = await visitor(browser);
  await v.goto("/book/dora");
  await expect(v.getByTestId("public-page")).toContainText("Meeting");
  await expect(v.getByTestId("public-page")).not.toContainText("Once a day");
  await v.goto("/book/dora/once-a-day");
  await book(v, at(W, "10:00"), "Eve", "eve@example.com");
  await v.goto("/book/dora/once-a-day");
  await expect(v.getByTestId("times")).toBeVisible();
  const starts = await v
    .locator('[data-testid="times"] button[data-start]')
    .evaluateAll((els) => els.map((e) => Number(e.getAttribute("data-start"))));
  expect(starts.some((s) => s >= at(W, "00:00") && s < at(day(1), "00:00"))).toBe(false);
  expect(starts.some((s) => s >= at(day(1), "00:00") && s < at(day(2), "00:00"))).toBe(true);
});

test("the visitor reschedules and then cancels from the manage page (rules 16-18)", async ({
  page,
  browser,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await claimPage(page, "finn");
  await addLink(page, { title: "Chat", durations: "30" });
  const v = await visitor(browser);
  await v.goto("/book/finn/chat");
  await book(v, at(W, "11:00"), "Gus", "gus@example.com");
  const created = await eventually(
    () => allEvents(cal),
    (l) => expect(l.find((e) => e.summary === "Chat with Gus")).toBeDefined(),
  );
  const id = created.find((e) => e.summary === "Chat with Gus")?.id;
  await v.getByTestId("manage-link").click();
  await expect(v.getByTestId("manage-page")).toBeVisible();
  await v.getByRole("button", { name: "Reschedule" }).click();
  await slot(v, at(day(1), "14:00")).click();
  await expect(v.getByText("Your booking has a new time.")).toBeVisible();
  const moved = await eventually(
    () => allEvents(cal),
    (l) =>
      expect(local(l.find((e) => e.summary === "Chat with Gus")?.start ?? 0)).toBe(
        `${day(1)} 14:00`,
      ),
  );
  expect(moved.find((e) => e.summary === "Chat with Gus")?.id).toBe(id);
  await v.reload();
  await expect(v.getByTestId("booking-status")).toContainText(":");
  await v.getByRole("button", { name: "Cancel booking" }).click();
  await expect(v.getByTestId("booking-status")).toHaveText("Cancelled");
  await eventually(
    () => allEvents(cal),
    (l) => expect(l.find((e) => e.summary === "Chat with Gus")).toBeUndefined(),
  );
  await v.goto("/book/finn/chat");
  await expect(slot(v, at(day(1), "14:00"))).toBeVisible();
});
