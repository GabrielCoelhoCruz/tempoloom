// Calendar mirroring between two calendars (docs/specs/sync-calendar-mirroring.md).
import type { Page } from "@playwright/test";
import { addDays } from "../../src/shared/time.ts";
import {
  at,
  BACKEND,
  blockUntil,
  type CalendarDriver,
  eventually,
  expect,
  local,
  test,
} from "./fixtures.ts";
import { addTask, titled, W } from "./helpers.ts";

const day = (n: number) => addDays(W, n);
const week = (cal: CalendarDriver) => cal.events(at(W, "00:00"), at(day(7), "00:00"));
const copies = (evs: Awaited<ReturnType<typeof week>>) =>
  evs.filter((e) => e.privateProps.tl === "1" && e.privateProps.tl_key?.startsWith("mirror:"));

test.skip(BACKEND === "google", "Mirroring E2E uses two CalDAV calendars.");

async function mirror(page: Page, from: string, to: string, visibility = "A label only") {
  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Refresh calendar list" }).click();
  await expect(page.getByTestId("calendar-list")).toContainText(from);
  const form = page.getByTestId("mirror-form");
  await form.getByLabel("Copy events from").selectOption({ label: from });
  await form.getByLabel("To").selectOption({ label: to });
  await form.getByLabel("Copies show").selectOption({ label: visibility });
  await form.getByRole("button", { name: "Add mirroring" }).click();
  await expect(page.getByTestId("mirror-list")).toContainText(`${from} → ${to}`);
}

test("copies follow the source: create, label, skip rules, move, delete, put back, turn off (rules 14-43)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  const priv = await cal.newCalendar("Private");
  const dentist = await priv.addEvent({
    title: "Dentist",
    start: at(W, "10:00"),
    end: at(W, "11:00"),
  });
  await priv.addEvent({ title: "Secret #tl_nosync", start: at(W, "13:00"), end: at(W, "14:00") });
  await priv.addEvent({
    title: "Maybe yoga",
    start: at(W, "15:00"),
    end: at(W, "16:00"),
    busy: false,
  });
  await priv.addInvite({
    title: "Party",
    start: at(day(1), "18:00"),
    end: at(day(1), "20:00"),
    answer: "DECLINED",
  });
  await mirror(page, "Private", "Work");

  const first = await eventually(
    () => week(cal),
    (l) => expect(copies(l)).toHaveLength(1),
  );
  const [copy] = copies(first);
  expect([copy?.summary, local(copy?.start ?? 0), local(copy?.end ?? 0), copy?.busy]).toEqual([
    "🏠 Personal commitment",
    `${W} 10:00`,
    `${W} 11:00`,
    true,
  ]);
  expect(copy?.description).toContain("Copied by Tempoloom");
  // The source calendar now counts for availability: a task avoids the dentist.
  await page.getByRole("link", { name: "Settings" }).click();
  await expect(
    page
      .getByTestId("calendar-list")
      .locator("label", { hasText: "Private" })
      .getByRole("checkbox"),
  ).toBeChecked();
  await addTask(page, { title: "AT-Around", minutes: 120, split: false, due: "" });
  await eventually(
    () => week(cal),
    (l) => expect(local(titled(l, "AT-Around")[0]?.start ?? 0)).toBe(`${W} 11:00`),
  );

  // Move the source: the copy moves (rule 35).
  await priv.update(dentist, { start: at(day(2), "08:00"), end: at(day(2), "09:00") });
  await eventually(
    () => week(cal),
    (l) => expect(copies(l).map((e) => local(e.start))).toEqual([`${day(2)} 08:00`]),
  );
  // Edit the copy by hand: it is put back (rule 38).
  const moved = copies(await week(cal))[0];
  if (!moved) throw new Error("no copy");
  await cal.update(moved.id, { start: moved.start, end: moved.end, summary: "Edited copy" });
  await eventually(
    () => week(cal),
    (l) => expect(copies(l)[0]?.summary).toBe("🏠 Personal commitment"),
  );
  // Delete the source: the copy goes (rule 36).
  await priv.remove(dentist);
  await eventually(
    () => week(cal),
    (l) => expect(copies(l)).toHaveLength(0),
  );
  // A new event, then turn the policy off: its copies are removed (rule 41).
  await priv.addEvent({ title: "Physio", start: at(day(3), "09:00"), end: at(day(3), "10:00") });
  await eventually(
    () => week(cal),
    (l) => expect(copies(l)).toHaveLength(1),
  );
  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByTestId("mirror-list").getByRole("button", { name: "Turn off" }).click();
  await eventually(
    () => week(cal),
    (l) => expect(copies(l)).toHaveLength(0),
  );
  await page.reload();
  await expect(page.getByTestId("mirror-list")).toContainText("off");
});

test("details mode copies the title; two-way mirroring never copies a copy (rules 15, 26)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  const priv = await cal.newCalendar("Private");
  await priv.addEvent({ title: "Climbing", start: at(day(1), "18:00"), end: at(day(1), "19:00") });
  await cal.addEvent({ title: "Standup", start: at(day(1), "09:00"), end: at(day(1), "09:15") });
  await mirror(page, "Private", "Work", "Details");
  await mirror(page, "Work", "Private");
  const work = await eventually(
    () => week(cal),
    (l) => expect(copies(l).map((e) => e.summary)).toEqual(["Climbing"]),
  );
  expect(copies(work)[0]?.busy).toBe(true);
  const priv2 = await eventually(
    () => week(priv),
    (l) => expect(copies(l).map((e) => e.summary)).toEqual(["🏠 Personal commitment"]),
  );
  // The copy of Standup is on Private; Climbing's copy on Work is not copied back.
  expect(copies(priv2)).toHaveLength(1);
  expect(local(copies(priv2)[0]?.start ?? 0)).toBe(`${day(1)} 09:00`);
});
