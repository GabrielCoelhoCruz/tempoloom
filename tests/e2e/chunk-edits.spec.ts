// Calendar edits of task chunks and the unlock triggers
// (docs/specs/planning-calendar-edits.md CED-11 to CED-14, CED-21, CED-22,
// CED-27, CED-30; planning-locks.md LCK-40; planning-defense.md DEF-12).
//
// Ways it can fail, and the test that catches each:
// - a move of the first chunk leaves the task's start as it was, so the
//   other chunk stays before the moved one, or an earlier move does not
//   show the earlier start                                           -> first chunk
// - a chunk moved past the due date leaves the other chunk free     -> past due
// - a shorter chunk does not give its minutes back, or a longer one
//   does not take them from the rest of the task                    -> resize
// - a deleted past chunk leaves a used-up task without work, or a done
//   task stays done; a shorter past chunk keeps its minutes         -> past chunks
// - a locked event comes back locked after a delete, or stays locked
//   at its time after a reschedule or a decline                     -> unlock
import { localToUtc } from "../../src/shared/time.ts";
import { boxOf, day, span, week } from "./automation-helpers.ts";
import {
  at,
  BACKEND,
  blockUntil,
  type CalendarDriver,
  eventually,
  expect,
  local,
  test,
  ZONE,
} from "./fixtures.ts";
import { addHabit, addTask, MIN, openWeek, titled, W } from "./helpers.ts";
import { addMeeting, answerAs } from "./meeting-helpers.ts";

const twoWeeks = (cal: CalendarDriver) => cal.events(at(W, "00:00"), at(day(14), "00:00"));
const LOCK = "🔒";
const iso = (date: string, hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  return new Date(localToUtc(ZONE, date, h * 60 + m)).toISOString();
};

test("moving the first chunk later moves the task's start, so no chunk goes before it; moving it earlier sets an earlier start (CED-11)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await addTask(page, { title: "AT-E1", minutes: 120, min: 60, max: 60, due: "" });
  const placed = await eventually(
    () => week(cal),
    (l) => expect(titled(l, "AT-E1")).toHaveLength(2),
  );
  // Both chunks are on Monday: without the rule the second one stays there.
  for (const e of titled(placed, "AT-E1")) expect(local(e.start).startsWith(W)).toBe(true);
  const [first] = titled(placed, "AT-E1");
  if (!first) throw new Error("no first chunk");
  await cal.update(first.id, { start: at(day(2), "15:00"), end: at(day(2), "16:00") });
  const check = (l: Awaited<ReturnType<typeof week>>) => {
    const chunks = titled(l, "AT-E1");
    expect(chunks).toHaveLength(2);
    const moved = chunks.find((e) => e.id === first.id);
    expect(moved && span(moved)).toBe(`${day(2)} 15:00-16:00`);
    expect(moved?.summary).toBe(`${LOCK} AT-E1`);
    const other = chunks.find((e) => e.id !== first.id);
    expect(other && other.start >= at(day(2), "16:00")).toBe(true);
  };
  await eventually(() => week(cal), check);
  await page.getByRole("link", { name: "Tasks" }).click();
  const start = page.locator('[data-task-title="AT-E1"]').getByTestId("task-start");
  await expect(start).toHaveAttribute("data-at", String(at(day(2), "15:00")));

  // Earlier: a task that starts on Tuesday moves to Monday 14:00.
  await addTask(page, {
    title: "AT-E2",
    minutes: 60,
    split: false,
    due: "",
    startAfter: `${day(1)}T09:00`,
  });
  const [late] = titled(
    await eventually(
      () => week(cal),
      (l) => expect(titled(l, "AT-E2").map(span)).toEqual([`${day(1)} 09:00-10:00`]),
    ),
    "AT-E2",
  );
  if (!late) throw new Error("no chunk");
  const before = page.locator('[data-task-title="AT-E2"]').getByTestId("task-start");
  await expect(before).toHaveAttribute("data-at", String(at(day(1), "09:00")));
  await cal.update(late.id, { start: at(W, "14:00"), end: at(W, "15:00") });
  await eventually(
    () => week(cal),
    (l) =>
      expect(titled(l, "AT-E2").map((e) => `${e.summary} ${span(e)}`)).toEqual([
        `${LOCK} AT-E2 ${W} 14:00-15:00`,
      ]),
  );
  await expect(before).toHaveAttribute("data-at", String(at(W, "14:00")));
  await page.reload();
  await page.getByRole("link", { name: "Tasks" }).click();
  await expect(before).toHaveAttribute("data-at", String(at(W, "14:00")));
  await expect(start).toHaveAttribute("data-at", String(at(day(2), "15:00")));
  check(await week(cal));
});

test("a chunk moved past the due date makes every chunk of its task busy (CED-12, DEF-12)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await addTask(page, {
    title: "AT-E3",
    minutes: 120,
    min: 60,
    max: 60,
    due: `${day(2)}T17:00`,
  });
  // With two days to spare, both chunks are free.
  const placed = await eventually(
    () => week(cal),
    (l) => {
      const chunks = titled(l, "AT-E3");
      expect(chunks).toHaveLength(2);
      for (const e of chunks) expect([e.summary, e.busy]).toEqual(["○ AT-E3", false]);
    },
  );
  const [, second] = titled(placed, "AT-E3");
  if (!second) throw new Error("no second chunk");
  await cal.update(second.id, { start: at(day(3), "10:00"), end: at(day(3), "11:00") });
  const check = (l: Awaited<ReturnType<typeof week>>) => {
    const chunks = titled(l, "AT-E3");
    expect(chunks).toHaveLength(2);
    const moved = chunks.find((e) => e.id === second.id);
    expect(moved && span(moved)).toBe(`${day(3)} 10:00-11:00`);
    expect(moved?.summary).toBe(`${LOCK} AT-E3`);
    const other = chunks.find((e) => e.id !== second.id);
    expect(other?.summary).toBe("● AT-E3");
    for (const e of chunks) expect(e.busy).toBe(true);
  };
  await eventually(() => week(cal), check);
  await page.reload();
  await openWeek(page);
  await expect(page.locator(".ev-task", { hasText: "AT-E3" })).toHaveCount(2);
  check(await week(cal));
});

test("a shorter chunk gives its minutes back to the task and a longer chunk takes them from the rest (CED-13, CED-14)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await addTask(page, { title: "AT-E4", minutes: 120, split: false, due: "" });
  const [chunk] = titled(
    await eventually(
      () => week(cal),
      (l) => expect(titled(l, "AT-E4").map(span)).toEqual([`${W} 09:00-11:00`]),
    ),
    "AT-E4",
  );
  if (!chunk) throw new Error("no chunk");
  // Shorter: locked 09:00 to 10:00, and a new 60-minute chunk later.
  await cal.update(chunk.id, { start: at(W, "09:00"), end: at(W, "10:00") });
  await eventually(
    () => week(cal),
    (l) => {
      const chunks = titled(l, "AT-E4");
      expect(chunks.map((e) => `${e.summary} ${span(e)}`)[0]).toBe(
        `${LOCK} AT-E4 ${W} 09:00-10:00`,
      );
      expect(chunks).toHaveLength(2);
      expect(chunks[1] && chunks[1].end - chunks[1].start).toBe(60 * MIN);
      expect(chunks[1] && chunks[1].start >= at(W, "10:00")).toBe(true);
    },
  );
  // Longer: the locked chunk takes 30 more minutes; the other chunk gives them up.
  await cal.update(chunk.id, { start: at(W, "09:00"), end: at(W, "10:30") });
  const check = (l: Awaited<ReturnType<typeof week>>) => {
    const chunks = titled(l, "AT-E4");
    expect(chunks.map((e) => `${e.summary} ${span(e)}`)[0]).toBe(`${LOCK} AT-E4 ${W} 09:00-10:30`);
    expect(chunks.map((e) => (e.end - e.start) / MIN)).toEqual([90, 30]);
  };
  await eventually(() => week(cal), check);
  await page.reload();
  await page.getByRole("link", { name: "Tasks" }).click();
  await expect(page.locator('[data-task-title="AT-E4"]').getByTestId("task-left")).toHaveText(
    "2 h left",
  );
  check(await week(cal));
});

test("past chunks: a delete brings the work back and reopens a done task; a shorter past chunk gives its minutes back (CED-13, CED-21, CED-22)", async ({
  page,
  app,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await addTask(page, { title: "AT-E6 used", minutes: 60, split: false, due: "" });
  await addTask(page, { title: "AT-E6 done", minutes: 60, split: false, due: "" });
  await addTask(page, { title: "AT-E6 cut", minutes: 120, split: false, due: "" });
  const placed = await eventually(
    () => week(cal),
    (l) => {
      // All three fill Monday 09:00 to 13:00, before the clock moves to 14:00.
      const chunks = titled(l, "AT-E6");
      expect(chunks.map((e) => (e.end - e.start) / MIN).sort((a, b) => a - b)).toEqual([
        60, 60, 120,
      ]);
      expect(chunks[0]?.start).toBe(at(W, "09:00"));
      expect(chunks.at(-1)?.end).toBe(at(W, "13:00"));
    },
  );
  const chunkOf = (title: string) => {
    const e = titled(placed, title)[0];
    if (!e) throw new Error(`no chunk of ${title}`);
    return e;
  };

  // Monday 14:00: all three chunks are in the past and the work is used up.
  app.env.TEST_CLOCK_START = iso(W, "14:00");
  await app.restart();
  await page.reload();
  await page.getByRole("link", { name: "Tasks" }).click();
  const state = (title: string) =>
    page.locator(`[data-task-title="${title}"]`).getByTestId("task-state");
  for (const t of ["AT-E6 used", "AT-E6 done", "AT-E6 cut"])
    await expect(state(t)).toHaveText("time-used");
  await page
    .locator('[data-task-title="AT-E6 done"]')
    .getByRole("button", { name: "Done" })
    .click();
  await expect(page.locator('[data-task-title="AT-E6 done"]')).toHaveCount(0);

  await cal.remove(chunkOf("AT-E6 used").id);
  await cal.remove(chunkOf("AT-E6 done").id);
  const cut = chunkOf("AT-E6 cut");
  await cal.update(cut.id, { start: cut.start, end: cut.start + 60 * MIN });
  const future = (l: Awaited<ReturnType<typeof week>>, title: string) =>
    titled(l, title)
      .filter((e) => e.start >= at(W, "14:00"))
      .map((e) => (e.end - e.start) / MIN);
  const check = (l: Awaited<ReturnType<typeof week>>) => {
    // The same length again, after now.
    expect(future(l, "AT-E6 used")).toEqual([60]);
    expect(future(l, "AT-E6 done")).toEqual([60]);
    expect(future(l, "AT-E6 cut")).toEqual([60]);
    expect(
      titled(l, "AT-E6 cut")
        .filter((e) => e.start < at(W, "14:00"))
        .map(span),
    ).toEqual([span({ start: cut.start, end: cut.start + 60 * MIN })]);
  };
  await eventually(() => week(cal), check, 60_000);
  for (const t of ["AT-E6 used", "AT-E6 done", "AT-E6 cut"])
    await expect(state(t)).toHaveText("scheduled");
  await page.reload();
  await page.getByRole("link", { name: "Tasks" }).click();
  for (const t of ["AT-E6 used", "AT-E6 done", "AT-E6 cut"])
    await expect(state(t)).toHaveText("scheduled");
  check(await week(cal));
});

test("a delete, a reschedule and a decline end a lock: the item is placed again away from the locked time (LCK-40, CED-27, CED-30)", async ({
  page,
  app,
  cal,
  signIn,
}) => {
  test.skip(BACKEND === "google", "The decline is written as a guest's answer (CalDAV only).");
  await blockUntil(cal, W);
  await signIn();
  await addTask(page, { title: "AT-U1", minutes: 60, split: false, due: "" });
  await addHabit(page, { title: "AT-U2", ideal: "12:00", min: 30, max: 30 });
  await addMeeting(page, { title: "AT-U3", guests: "dana@example.com", idealTime: "15:00" });
  const placed = await eventually(
    () => twoWeeks(cal),
    (l) => {
      expect(titled(l, "AT-U1").map(span)).toEqual([`${W} 09:00-10:00`]);
      expect(titled(l, "AT-U2").map(span)).toContain(`${day(1)} 12:00-12:30`);
      expect(titled(l, "AT-U3").map(span)).toContain(`${day(1)} 15:00-15:30`);
    },
  );
  const on = (title: string, date: string) => {
    const e = titled(placed, title).find((x) => local(x.start).startsWith(date));
    if (!e) throw new Error(`no ${title} on ${date}`);
    return e;
  };
  const task = on("AT-U1", W);
  const habit = on("AT-U2", day(1));
  const meeting = on("AT-U3", day(1));
  await openWeek(page);
  for (const e of [task, habit, meeting]) {
    await (await boxOf(page, app, e.id)).click();
    await page.getByTestId("event-drawer").getByRole("button", { name: "Lock" }).click();
    await expect(page.getByTestId("event-drawer")).toHaveCount(0);
  }
  await eventually(
    () => twoWeeks(cal),
    (l) => {
      for (const e of [task, habit, meeting])
        expect(l.find((x) => x.id === e.id)?.summary.startsWith(LOCK)).toBe(true);
    },
  );

  // Delete: the task goes to a later day, unlocked.
  await cal.remove(task.id);
  // Reschedule: the habit occurrence goes to 16:00 although it was locked at 12:00.
  await openWeek(page);
  await (await boxOf(page, app, habit.id)).click();
  const form = page.getByTestId("reschedule-form");
  await form.getByLabel("Reschedule to").fill("16:00");
  await form.getByRole("button", { name: "Reschedule" }).click();
  await expect(page.getByTestId("event-drawer")).toHaveCount(0);
  // Decline: the guest declines the locked occurrence; it moves.
  await answerAs(cal.calendarId, meeting.id, "dana@example.com", "DECLINED");

  const check = (l: Awaited<ReturnType<typeof twoWeeks>>) => {
    const [t] = titled(l, "AT-U1");
    expect(t && t.start >= at(day(1), "00:00")).toBe(true);
    expect(t?.summary.startsWith(LOCK)).toBe(false);
    const h = titled(l, "AT-U2").filter((e) => local(e.start).startsWith(day(1)));
    expect(h.map(span)).toEqual([`${day(1)} 16:00-16:30`]);
    expect(h[0]?.summary.startsWith(LOCK)).toBe(false);
    const m = titled(l, "AT-U3").filter((e) => local(e.start).startsWith(day(1)));
    expect(m).toHaveLength(1);
    expect(m.map(span)).not.toContain(`${day(1)} 15:00-15:30`);
    expect(m[0]?.summary.startsWith(LOCK)).toBe(false);
  };
  await eventually(() => twoWeeks(cal), check, 60_000);
  await page.reload();
  await openWeek(page);
  await expect(page.locator(".ev-locked", { hasText: "AT-U" })).toHaveCount(0);
  check(await twoWeeks(cal));
});
