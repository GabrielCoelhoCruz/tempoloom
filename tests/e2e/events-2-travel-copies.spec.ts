// Travel buffer visibility (docs/specs/buffers-travel.md outputs): travel
// buffers are public on the main calendar, and on a mirrored calendar their
// copies follow the mirroring policy (sync-calendar-mirroring.md rules 15, 27).
//
// Ways this can fail, each covered below:
// - travel buffers are never copied, because every managed event is skipped;
// - a copy of a travel buffer ignores the policy (details where the policy shows
//   a label, or the reverse);
// - other managed events (task chunks) are copied too;
// - the copies go away or change after a reload and another run.
import { addDays } from "../../src/shared/time.ts";
import { addPolicy, copies } from "./calendar-helpers.ts";
import { at, BACKEND, blockUntil, expect, local, planNow, test } from "./fixtures.ts";
import { addTask, titled, W } from "./helpers.ts";

test.skip(BACKEND === "google", "Mirroring E2E uses more CalDAV calendars of one account.");

const tue = addDays(W, 1);
const spans = (l: { summary: string; start: number; end: number }[]) =>
  l.map((e) => `${e.summary} ${local(e.start)}-${local(e.end).slice(11)}`);

test("copies of travel buffers on mirrored calendars show what each policy shows, while the main calendar keeps them with the travel marker (buffers-travel outputs)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await cal.addEvent({
    title: "Client visit",
    start: at(tue, "14:00"),
    end: at(tue, "15:00"),
    location: "1 Oak Ave, Springfield, IL 62701",
  });
  await signIn();
  const labels = await cal.newCalendar("Labels");
  const details = await cal.newCalendar("Details");
  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Add travel time (30 min)" }).click();
  await expect(page.getByTestId("buffer-list")).toContainText("Travel");
  await addTask(page, { title: "AT-NoCopy", minutes: 60, split: false, due: "" });
  await addPolicy(page, {
    from: "Work",
    to: "Labels",
    show: "A label only",
    label: "Work commitment",
  });
  await addPolicy(page, { from: "Work", to: "Details", show: "Details" });

  const read = (c: typeof labels) => c.events(at(tue, "00:00"), at(addDays(tue, 1), "00:00"));
  const expected = async () => {
    const main = await cal.events(at(tue, "00:00"), at(addDays(tue, 1), "00:00"));
    const travel = titled(main, "Travel");
    expect(spans(travel)).toEqual([`🚌 Travel ${tue} 13:30-14:00`, `🚌 Travel ${tue} 15:00-15:30`]);
    const l = copies(await read(labels));
    expect(spans(l)).toEqual([
      `Travel ${tue} 13:30-14:00`,
      `Work commitment ${tue} 14:00-15:00`,
      `Travel ${tue} 15:00-15:30`,
    ]);
    const d = copies(await read(details));
    expect(spans(d)).toEqual([
      `🚌 Travel ${tue} 13:30-14:00`,
      `Client visit ${tue} 14:00-15:00`,
      `🚌 Travel ${tue} 15:00-15:30`,
    ]);
    // Task chunks stay on the main calendar only.
    const all = [...(await labels.events(at(W, "00:00"), at(addDays(W, 7), "00:00")))];
    expect(all.some((e) => e.summary.includes("AT-NoCopy"))).toBe(false);
  };
  await expect(expected).toPass({ timeout: 60_000 });
  await page.reload();
  await planNow(page);
  await expected();
});
