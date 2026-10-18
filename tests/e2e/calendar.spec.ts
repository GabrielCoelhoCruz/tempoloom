// What the calendar tells the scheduler: invitations, free and all-day events,
// title tags, other calendars, and edits the user makes in the calendar.
import { addDays } from "../../src/shared/time.ts";
import { at, BACKEND, blockUntil, eventually, expect, local, test } from "./fixtures.ts";
import { addTask, allEvents, MIN, openEvent, openWeek, titled, W } from "./helpers.ts";

const tue = addDays(W, 1);

test("unanswered and declined invitations do not block; accepted ones do (SCH-20, SCH-21)", async ({
  page,
  cal,
  signIn,
}) => {
  test.skip(BACKEND === "google", "A service account cannot receive invitations.");
  await blockUntil(cal, W);
  await cal.addInvite({
    title: "Maybe later",
    start: at(W, "09:00"),
    end: at(W, "10:00"),
    answer: "NEEDS-ACTION",
  });
  await cal.addInvite({
    title: "Planning",
    start: at(W, "10:00"),
    end: at(W, "11:00"),
    answer: "ACCEPTED",
  });
  await cal.addInvite({
    title: "Not going",
    start: at(W, "11:00"),
    end: at(W, "12:00"),
    answer: "DECLINED",
  });
  await signIn();
  await addTask(page, { title: "AT-Inv A", minutes: 60, split: false, due: "" });
  await addTask(page, { title: "AT-Inv B", minutes: 60, split: false, due: "" });
  const evs = await eventually(
    () => allEvents(cal),
    (l) => expect(titled(l, "AT-Inv")).toHaveLength(2),
  );
  expect(titled(evs, "AT-Inv").map((e) => local(e.start))).toEqual([`${W} 09:00`, `${W} 11:00`]);
});

test("free events do not block; a busy all-day event blocks its whole day (SCH-22, SCH-25)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await cal.addAllDay(W, "Conference", true);
  await cal.addAllDay(tue, "Holiday (free)", false);
  await cal.addEvent({
    title: "Optional talk",
    start: at(tue, "09:00"),
    end: at(tue, "12:00"),
    busy: false,
  });
  await signIn();
  await addTask(page, { title: "AT-AllDay", minutes: 60, split: false, due: "" });
  const evs = await eventually(
    () => allEvents(cal),
    (l) => expect(titled(l, "AT-AllDay")).toHaveLength(1),
  );
  expect(local(titled(evs, "AT-AllDay")[0]?.start ?? 0)).toBe(`${tue} 09:00`);
});

test("#tl_free opens busy time to tasks; #tl_busy closes free time, in title or description (SCH-23, SCH-24, events-tags 1-12)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await cal.addEvent({ title: "No meetings #tl_free", start: at(W, "09:00"), end: at(W, "10:00") });
  await cal.addEvent({
    title: "Gym hold",
    start: at(W, "10:00"),
    end: at(W, "17:00"),
    busy: false,
  });
  await signIn();
  // The #tl_busy tag in a description: set it through the calendar as the user would.
  const all = await allEvents(cal);
  const hold = all.find((e) => e.summary === "Gym hold");
  if (!hold) throw new Error("hold missing");
  await cal.remove(hold.id);
  await cal.addEvent({
    title: "Gym hold #tl_busy",
    start: at(W, "10:00"),
    end: at(W, "17:00"),
    busy: false,
  });
  await addTask(page, { title: "AT-Tag A", minutes: 60, split: false, due: "" });
  await addTask(page, { title: "AT-Tag B", minutes: 60, split: false, due: "" });
  const evs = await eventually(
    () => allEvents(cal),
    (l) => expect(titled(l, "AT-Tag")).toHaveLength(2),
  );
  expect(titled(evs, "AT-Tag").map((e) => local(e.start))).toEqual([`${W} 09:00`, `${tue} 09:00`]);
});

test("moving a chunk in the calendar locks it there; the planner shows the lock (CED-1, LCK-4)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await addTask(page, { title: "AT-Moved", minutes: 60, split: false, due: "" });
  const [chunk] = titled(
    await eventually(
      () => allEvents(cal),
      (l) => expect(titled(l, "AT-Moved")).toHaveLength(1),
    ),
    "AT-Moved",
  );
  if (!chunk) throw new Error("no chunk");
  await cal.update(chunk.id, { start: at(tue, "15:00"), end: at(tue, "16:00") });
  const evs = await eventually(
    () => allEvents(cal),
    (l) => expect(titled(l, "AT-Moved")[0]?.summary).toBe("🔒 AT-Moved"),
  );
  expect(local(titled(evs, "AT-Moved")[0]?.start ?? 0)).toBe(`${tue} 15:00`);
  expect(titled(evs, "AT-Moved")[0]?.busy).toBe(true);
  await openWeek(page);
  await expect(page.locator(".ev-task.ev-locked", { hasText: "AT-Moved" })).toBeVisible();
});

test("lock and unlock from the planner details panel (LCK-10, LCK-41)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await addTask(page, {
    title: "AT-Lock",
    minutes: 60,
    split: false,
    due: `${addDays(W, 4)}T17:00`,
  });
  await eventually(
    () => allEvents(cal),
    (l) => expect(titled(l, "AT-Lock")[0]?.summary).toBe("○ AT-Lock"),
  );
  await openWeek(page);
  await openEvent(page, "AT-Lock");
  await page.getByTestId("event-drawer").getByRole("button", { name: "Lock" }).click();
  const locked = await eventually(
    () => allEvents(cal),
    (l) => expect(titled(l, "AT-Lock")[0]?.summary).toBe("🔒 AT-Lock"),
  );
  expect(titled(locked, "AT-Lock")[0]?.busy).toBe(true);
  // A meeting over a locked chunk does not move it.
  const at0 = titled(locked, "AT-Lock")[0]?.start ?? 0;
  await cal.addEvent({ title: "Clash", start: at0, end: at0 + 30 * MIN });
  await page.waitForTimeout(6500);
  expect(titled(await allEvents(cal), "AT-Lock")[0]?.start).toBe(at0);
  // Unlock: the scheduler is free to move it away from the clash again.
  await openWeek(page);
  await openEvent(page, "AT-Lock");
  await page.getByTestId("event-drawer").getByRole("button", { name: "Unlock" }).click();
  await eventually(
    () => allEvents(cal),
    (l) => {
      const [c] = titled(l, "AT-Lock");
      expect(c && (c.start >= at0 + 30 * MIN || c.end <= at0)).toBe(true);
      expect(c?.summary.startsWith("🔒")).toBe(false);
    },
  );
});

test("a title edit of a chunk in the calendar is put back (CED-41)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await addTask(page, { title: "AT-Title", minutes: 60, split: false, due: "" });
  const [chunk] = titled(
    await eventually(
      () => allEvents(cal),
      (l) => expect(titled(l, "AT-Title")).toHaveLength(1),
    ),
    "AT-Title",
  );
  if (!chunk) throw new Error("no chunk");
  await cal.update(chunk.id, { start: chunk.start, end: chunk.end, summary: "Renamed by hand" });
  await eventually(
    () => allEvents(cal),
    (l) => {
      const e = l.find((x) => x.id === chunk.id);
      expect(e?.summary).toBe(chunk.summary);
      expect(e?.start).toBe(chunk.start);
    },
  );
});

test("a second calendar blocks time only when it counts for availability (SPEC-ACCT-01)", async ({
  page,
  cal,
  signIn,
}) => {
  test.skip(BACKEND === "google", "Uses a second CalDAV calendar.");
  await blockUntil(cal, W);
  await signIn();
  const personal = await cal.newCalendar("Private");
  await personal.addEvent({ title: "Dentist", start: at(W, "09:00"), end: at(W, "12:00") });
  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Refresh calendar list" }).click();
  const list = page.getByTestId("calendar-list");
  await expect(list).toContainText("Private");
  await expect(list.locator("label", { hasText: "Work" }).getByRole("checkbox")).toBeChecked();
  const privateBox = list.locator("label", { hasText: "Private" }).getByRole("checkbox");
  await expect(privateBox).not.toBeChecked();
  await addTask(page, { title: "AT-Avail", minutes: 60, split: false, due: "" });
  await eventually(
    () => allEvents(cal),
    (l) => expect(local(titled(l, "AT-Avail")[0]?.start ?? 0)).toBe(`${W} 09:00`),
  );
  await page.getByRole("link", { name: "Settings" }).click();
  await privateBox.check();
  await eventually(
    () => allEvents(cal),
    (l) => expect(local(titled(l, "AT-Avail")[0]?.start ?? 0)).toBe(`${W} 12:00`),
  );
  // Managed events stay on the main calendar.
  expect(
    titled(await personal.events(at(W, "00:00"), at(addDays(W, 7), "00:00")), "AT-Avail"),
  ).toHaveLength(0);
  await page.reload();
  await expect(
    page
      .getByTestId("calendar-list")
      .locator("label", { hasText: "Private" })
      .getByRole("checkbox"),
  ).toBeChecked();
});
