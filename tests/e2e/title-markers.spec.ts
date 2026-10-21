// Title markers and user emoji (docs/specs/events-title-emoji.md).
//
// Ways this can fail, and the test that catches each:
// - An event that ended keeps its free, busy or lock marker instead of the done
//   marker; a task chunk with work left gets the done marker instead of the
//   partly done one; marking the task done does not change it (done test).
// - A marker is added again on every run ("✈️ ✈️ ..."), or the type marker and
//   the state marker are in the wrong order (type markers test).
// - Tempoloom renames a flight it may not edit, such as an invitation (type
//   markers test).
// - A mirrored copy with the personal commitment label has no house marker, or
//   gets reminders (type markers test).
// - A template's emoji cannot be removed in the form, or comes back when the
//   habits page's data loads after the removal; the user's own emoji is lost or
//   put before the marker when the state changes (emoji test).
import { addDays } from "../../src/shared/time.ts";
import { alarms, create, fillEventSettings, rawEvent, save } from "./automation-list-helpers.ts";
import {
  at,
  BACKEND,
  blockUntil,
  type CalendarDriver,
  eventually,
  expect,
  managed,
  planNow,
  test,
} from "./fixtures.ts";
import { addHabit, addTask, openWeek, titled, W } from "./helpers.ts";

const day = (n: number) => addDays(W, n);
const week = (cal: CalendarDriver) => cal.events(at(W, "00:00"), at(day(7), "00:00"));
/** From yesterday to the end of the test week: includes events that already ended. */
const span = (cal: CalendarDriver) => cal.events(Date.now() - 86_400_000, at(day(7), "00:00"));
const MIN = 60_000;
/** A quarter-hour start some hours ago, so the moved event has ended. */
const pastStart = (hoursAgo: number) =>
  Math.floor((Date.now() - hoursAgo * 3_600_000) / (15 * MIN)) * 15 * MIN;

test("an ended habit event gets the done marker; an ended task chunk gets the partly done marker until the task is done (marker table; rules 2, 5)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await addHabit(page, { title: "Lunch", ideal: "12:00", min: 60, max: 60 });
  await addTask(page, { title: "AT-Report", minutes: 60, min: 30, max: 30, due: "" });
  const evs = await eventually(
    () => week(cal),
    (l) => {
      expect(titled(l, "Lunch")).toHaveLength(5);
      expect(titled(l, "AT-Report")).toHaveLength(2);
    },
  );
  // The user moves one lunch and one chunk to earlier today in another calendar app:
  // they happened already.
  const lunch = titled(evs, "Lunch")[0];
  const chunk = titled(evs, "AT-Report")[0];
  if (!lunch || !chunk) throw new Error("missing events");
  await cal.update(lunch.id, { start: pastStart(2), end: pastStart(2) + 60 * MIN });
  await cal.update(chunk.id, { start: pastStart(1), end: pastStart(1) + 30 * MIN });

  const byId = (l: Awaited<ReturnType<typeof span>>, id: string) => l.find((e) => e.id === id);
  await eventually(
    () => span(cal),
    (l) => {
      expect(byId(l, lunch.id)?.summary).toBe("✅ Lunch");
      // The task still has 30 minutes to place.
      expect(byId(l, chunk.id)?.summary).toBe("👍 AT-Report");
    },
  );
  await page.getByRole("link", { name: "Tasks" }).click();
  await page.locator('[data-task-title="AT-Report"]').getByRole("button", { name: "Done" }).click();
  await eventually(
    () => span(cal),
    (l) => {
      expect(byId(l, chunk.id)?.summary).toBe("✅ AT-Report");
      expect(titled(l, "AT-Report")).toHaveLength(1);
    },
  );
  // Another run changes nothing: one marker each.
  await planNow(page);
  await page.reload();
  const after = await span(cal);
  expect(byId(after, lunch.id)?.summary).toBe("✅ Lunch");
  expect(byId(after, chunk.id)?.summary).toBe("✅ AT-Report");
});

test("travel buffers, flights Tempoloom may edit and personal mirror copies get their markers once (marker table; rules 2, 8)", async ({
  page,
  cal,
  signIn,
}) => {
  test.skip(BACKEND === "google", "Uses a second CalDAV calendar and an invitation.");
  await blockUntil(cal, W);
  await cal.addEvent({
    title: "Client visit",
    start: at(day(1), "14:00"),
    end: at(day(1), "15:00"),
    location: "1 Oak Ave, Springfield, IL 62701",
  });
  const flight = await cal.addEvent({
    title: "Flight LH 1234",
    start: at(day(2), "10:00"),
    end: at(day(2), "12:00"),
  });
  const invite = await cal.addInvite({
    title: "Flight BA 99",
    start: at(day(3), "10:00"),
    end: at(day(3), "12:00"),
    answer: "ACCEPTED",
  });
  await signIn();
  const yoga = await cal.newCalendar("Yoga");
  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Refresh calendar list" }).click();
  await expect(page.getByTestId("calendar-list")).toContainText("Yoga");
  await page.getByRole("button", { name: "Add travel time (30 min)" }).click();
  await page.getByRole("button", { name: /Add airport time/ }).click();
  const mirror = page.getByTestId("mirror-form");
  await mirror.getByLabel("Copy events from").selectOption({ label: "Work" });
  await mirror.getByLabel("To").selectOption({ label: "Yoga" });
  await mirror.getByLabel("Copies show").selectOption({ label: "A label only" });
  // The label stays at its first choice, "Personal commitment".
  await mirror.getByRole("button", { name: "Add mirroring" }).click();

  const read = async () => ({ mine: await week(cal), copies: managed(await week(yoga)) });
  const check = ({ mine, copies }: Awaited<ReturnType<typeof read>>) => {
    expect(titled(mine, "Travel").map((e) => e.summary)).toEqual(["🚌 Travel", "🚌 Travel"]);
    // Both flights get airport time; only the user's own flight is renamed.
    expect(titled(mine, "Airport").map((e) => e.summary)).toEqual(Array(4).fill("🚌 Airport"));
    expect(mine.find((e) => e.id === flight)?.summary).toBe("✈️ Flight LH 1234");
    expect(mine.find((e) => e.id === invite)?.summary).toBe("Flight BA 99");
    expect(copies.length).toBeGreaterThanOrEqual(3);
    // Flights keep their category label (mirroring rule 27); only copies that
    // show the personal commitment label get the house marker.
    const labels = copies.map((c) => c.summary);
    expect(labels.filter((l) => l === "Flight")).toHaveLength(2);
    // Travel and airport buffers are copied too, with the travel label (buffers-travel outputs).
    expect(labels.filter((l) => l === "Travel")).toHaveLength(6);
    const other = labels.filter((l) => l !== "Flight" && l !== "Travel");
    expect(other.length).toBeGreaterThanOrEqual(1);
    for (const l of other) expect(l).toBe("🏠 Personal commitment");
  };
  const { copies } = await eventually(read, check);
  // Mirroring copies never get reminders (NTF table).
  expect(alarms(await rawEvent(copies[0]?.id ?? ""))).toEqual([]);

  // Another run and a reload add nothing.
  await planNow(page);
  await page.reload();
  check(await read());
});

test("a template's emoji shows in the form and can be removed; the user's own emoji stays after the state marker (rules 3, 4)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  const library = async (name: string) => {
    await page.getByRole("link", { name: "Library" }).click();
    await page.locator(`[data-entry="${name}"]`).getByRole("button", { name: "Use" }).click();
  };
  const form = page.getByTestId("habit-form");
  // A slow hours answer, as on a busy CI runner: data that comes in after the user removed
  // the emoji must not reset the form and bring the template's emoji back.
  await page.route("**/api/hours", async (route) => {
    await new Promise((r) => setTimeout(r, 1000));
    await route.continue();
  });
  const hoursAnswer = page.waitForResponse((r) => r.url().endsWith("/api/hours"));
  await library("Lunch");
  await expect(form.getByLabel("Emoji")).toHaveValue("🍱");
  await form.getByRole("button", { name: "Remove emoji" }).click();
  await hoursAnswer;
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
  await page.unrouteAll();
  await expect(form.getByLabel("Emoji")).toHaveValue("");
  await form.getByRole("button", { name: "Add habit" }).click();
  await expect(page.locator('[data-habit-title="Lunch"]')).toBeVisible();

  await library("Daily walk");
  await expect(form.getByLabel("Emoji")).toHaveValue("🚶");
  await form.getByRole("button", { name: "Add habit" }).click();
  await expect(page.locator('[data-habit-title="Daily walk"]')).toContainText("🚶 Daily walk");

  // An emoji typed into the title works the same.
  await addHabit(page, {
    title: "🧘 Stretch",
    ideal: "16:00",
    min: 30,
    max: 30,
    defense: "Always busy",
  });
  const buffer = await create(page, "Buffer");
  await buffer.getByLabel("Title").fill("Prep");
  await fillEventSettings(buffer, { emoji: "📝" });
  await buffer.getByLabel("Side").selectOption({ label: "Before" });
  await buffer.getByLabel("Before the event (minutes)").fill("15");
  await buffer.getByLabel("Which events").selectOption({ label: "Meetings with other people" });
  await save(buffer);
  await cal.addEvent({
    title: "Customer call",
    start: at(day(1), "10:00"),
    end: at(day(1), "11:00"),
    attendees: ["ana@example.com"],
  });

  const evs = await eventually(
    () => week(cal),
    (l) => {
      expect(titled(l, "Lunch").map((e) => e.summary)).toEqual(Array(5).fill("○ Lunch"));
      expect(titled(l, "Daily walk").map((e) => e.summary)).toEqual(
        Array(5).fill("○ 🚶 Daily walk"),
      );
      expect(titled(l, "Stretch").map((e) => e.summary)).toEqual(Array(5).fill("● 🧘 Stretch"));
      expect(titled(l, "Prep").map((e) => e.summary)).toEqual(["📝 Prep"]);
    },
  );

  // A lock changes only the marker.
  await openWeek(page);
  await page.locator(".ev-habit", { hasText: "Daily walk" }).first().click();
  await page.getByTestId("event-drawer").getByRole("button", { name: "Lock" }).click();
  const first = titled(evs, "Daily walk")[0]?.id;
  await eventually(
    () => week(cal),
    (l) => expect(l.find((e) => e.id === first)?.summary).toBe("🔒 🚶 Daily walk"),
  );
  await page.reload();
  await page.getByRole("link", { name: "Habits" }).click();
  await expect(page.locator('[data-habit-title="Lunch"]')).not.toContainText("🍱");
  await expect(page.locator('[data-habit-title="Daily walk"]')).toContainText("🚶 Daily walk");
});
