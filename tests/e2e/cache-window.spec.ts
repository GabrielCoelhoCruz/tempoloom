// Done work of a chunk older than the event cache window stays done
// (planning-calendar-edits.md CED-20 is about events the user deleted). The
// cache keeps 84 days of the past; a full read drops older events. The server
// clock is set (TEST_CLOCK_START) 100 days past the chunk.
//
// Ways this can fail:
// - the full read drops the old chunk, its managed row is deleted, and the
//   task shows its full time left again;
// - the scheduler then places the same work again in the calendar.
import { addDays, localToUtc } from "../../src/shared/time.ts";
import { at, blockUntil, eventually, expect, local, planNow, test, ZONE } from "./fixtures.ts";
import { addTask, titled, W } from "./helpers.ts";

const iso = (date: string, hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  return new Date(localToUtc(ZONE, date, h * 60 + m)).toISOString();
};

test("a chunk older than the cache window still counts as done work after a full read", async ({
  page,
  cal,
  app,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await addTask(page, { title: "Archive", minutes: 60, split: false, due: "" });
  const [chunk] = await eventually(
    () => cal.events(at(W, "00:00"), at(addDays(W, 7), "00:00")),
    (l) => expect(titled(l, "Archive")).toHaveLength(1),
  ).then((l) => titled(l, "Archive"));
  const row = page.locator('[data-task-title="Archive"]');
  await expect(row.getByTestId("task-left")).toHaveText("1 h left");

  // 100 days later: the chunk ended long ago and is out of the 84-day window.
  // The window is stale, so the next read is full and drops the old event.
  const later = addDays(W, 100);
  app.env.TEST_CLOCK_START = iso(later, "08:00");
  await app.restart();
  // The 30-day session has ended on the new clock.
  await signIn();
  await planNow(page);
  await expect
    .poll(
      () =>
        app.query<{ w: number }>("SELECT window_start AS w FROM calendars WHERE is_primary = 1")[0]
          ?.w ?? 0,
    )
    .toBeGreaterThan(chunk?.end ?? Number.POSITIVE_INFINITY);
  await planNow(page);

  await page.getByRole("link", { name: "Tasks" }).click();
  await expect(row.getByTestId("task-left")).toHaveText("0 min left");
  await expect(row.getByTestId("task-state")).toHaveText("time-used");
  expect(
    app.query<{ start_ms: number }>(
      "SELECT m.start_ms FROM managed_events m JOIN tasks t ON t.id = m.source_id WHERE t.title = 'Archive'",
    ),
  ).toEqual([{ start_ms: chunk?.start }]);
  // The work is not placed again.
  expect(
    titled(await cal.events(at(later, "00:00"), at(addDays(later, 30), "00:00")), "Archive").map(
      (e) => local(e.start),
    ),
  ).toEqual([]);

  await page.reload();
  await expect(row.getByTestId("task-left")).toHaveText("0 min left");
});
