// Connected calendars: shared calendars, full access only, one row per
// calendar, a category per calendar, and the guidance that explains connected
// calendars versus mirroring (docs/specs/accounts-connected-calendars.md
// rules 4-6, 8, 28-30; AT-8).
//
// Ways it can fail, and the test that catches each:
// - a calendar shared with full access cannot be added, or does not block
//   time once connected, or its check box does not persist                  -> shared
// - a read-only share is offered, or added and then listed                  -> shared
// - a calendar that two added accounts see is listed twice                  -> twice
// - the category of a calendar does not change the color of its events,
//   or does not persist; the main calendar has no category                  -> category
// - the page does not explain connected calendars versus mirroring, or the
//   button for a new mirroring policy goes nowhere                          -> category
// Every test reloads the page and reads the state again.

import { addSharedCalendar, calendarRow, openSettings, week } from "./calendar-helpers.ts";
import { addCalDavAccount } from "./delegation-helpers.ts";
import {
  at,
  BACKEND,
  blockUntil,
  COLLEAGUE_EMAIL,
  EMAIL,
  eventually,
  expect,
  local,
  test,
} from "./fixtures.ts";
import { addTask, allEvents, titled, W } from "./helpers.ts";

test.skip(BACKEND === "google", "Connected calendar E2E uses CalDAV sharing.");

test("a calendar shared with full access can be added, connected and blocks time; a read-only share is refused (rules 4, 30)", async ({
  cal,
  colleague,
  people,
}) => {
  // e2e owns "Shared"; e2e2 (the colleague) may change it, e2e3 may only read it.
  const shared = await cal.newCalendar("Shared");
  await shared.addEvent({ title: "Rota duty", start: at(W, "09:00"), end: at(W, "12:00") });
  await blockUntil(colleague.cal, W);
  const pc = await colleague.signIn();
  await addSharedCalendar(pc, shared.calendarId);
  await expect(pc.getByTestId("calendars-message")).toHaveText("Calendar added.");
  await expect(calendarRow(pc, "Shared")).toContainText(COLLEAGUE_EMAIL);
  const box = calendarRow(pc, "Shared").getByRole("checkbox");
  await expect(box).not.toBeChecked();
  await addTask(pc, { title: "AT-Rota", minutes: 60, split: false, due: "" });
  await eventually(
    () => allEvents(colleague.cal),
    (l) => expect(local(titled(l, "AT-Rota")[0]?.start ?? 0)).toBe(`${W} 09:00`),
  );
  await openSettings(pc);
  await calendarRow(pc, "Shared").getByRole("checkbox").check();
  await eventually(
    () => allEvents(colleague.cal),
    (l) => expect(local(titled(l, "AT-Rota")[0]?.start ?? 0)).toBe(`${W} 12:00`),
  );
  // Tempoloom writes nothing to the shared calendar.
  expect((await week(shared)).map((e) => e.summary)).toEqual(["Rota duty"]);
  await pc.reload();
  await expect(calendarRow(pc, "Shared").getByRole("checkbox")).toBeChecked();

  // Read-only access is not enough: the calendar is refused and not listed.
  const reader = await people(3);
  const p3 = await reader.signIn();
  await addSharedCalendar(p3, shared.calendarId);
  await expect(p3.getByTestId("calendars-message")).toHaveText(
    "Tempoloom needs read and write access to this calendar. This calendar is shared with you read-only.",
  );
  await expect(calendarRow(p3, "Shared")).toHaveCount(0);
  await p3.reload();
  await p3.getByRole("button", { name: "Refresh calendar list" }).click();
  await expect(p3.getByTestId("calendar-list")).toContainText(reader.email);
  await expect(calendarRow(p3, "Shared")).toHaveCount(0);
});

test("a calendar that two added accounts can see is listed once, under the account added first (rule 6; AT-8)", async ({
  page,
  cal,
  signIn,
  colleague,
  radicale,
}) => {
  if (!radicale) throw new Error("This test needs the CalDAV backend.");
  void colleague;
  await signIn();
  const shared = await cal.newCalendar("Shared");
  await openSettings(page);
  await page.getByRole("button", { name: "Refresh calendar list" }).click();
  await expect(calendarRow(page, "Shared")).toHaveCount(1);
  await addCalDavAccount(page, { ...radicale.colleague, email: COLLEAGUE_EMAIL });
  await addSharedCalendar(page, shared.calendarId, COLLEAGUE_EMAIL);
  await expect(page.getByTestId("calendars-message")).toHaveText("Calendar added.");
  await expect(calendarRow(page, "Shared")).toHaveCount(1);
  await expect(calendarRow(page, "Shared")).toContainText(EMAIL);
  await page.reload();
  await page.getByRole("button", { name: "Refresh calendar list" }).click();
  await expect(page.getByTestId("calendar-list")).toContainText(COLLEAGUE_EMAIL);
  await expect(calendarRow(page, "Shared")).toHaveCount(1);
  await expect(calendarRow(page, "Shared")).toContainText(EMAIL);
});

test("each connected calendar has a category that colors its events; the page explains connected calendars versus mirroring (rules 8, 28, 29)", async ({
  page,
  cal,
  signIn,
}) => {
  await signIn();
  const priv = await cal.newCalendar("Private");
  await priv.addEvent({ title: "Planning session", start: at(W, "10:00"), end: at(W, "11:00") });
  await openSettings(page);
  const help = page.getByTestId("calendars-help");
  await expect(help).toContainText(
    "Connected calendars: Tempoloom plans around their events. Other people do not see them.",
  );
  await expect(help).toContainText(
    "Mirroring: Tempoloom copies the busy time into another calendar, so people who book time on that calendar see it. Use it when other people book time directly on your calendar.",
  );
  await page.getByRole("button", { name: "New mirroring policy" }).click();
  await expect(page.getByTestId("mirror-form").getByLabel("Copy events from")).toBeFocused();

  // Paint all events; the category of the calendar decides their color.
  const colors = page.getByTestId("color-form");
  await colors.getByLabel("Paint").selectOption("all_events");
  await colors.getByRole("button", { name: "Save colors" }).click();
  await expect(page.getByTestId("settings-message")).toHaveText("Saved");
  await page.getByRole("button", { name: "Refresh calendar list" }).click();
  await calendarRow(page, "Private").getByRole("checkbox").check();
  await expect(page.getByLabel("Category of Work")).toHaveValue("business");
  const category = page.getByLabel("Category of Private");
  await expect(category).toHaveValue("business");
  const color = async () =>
    (await week(priv)).find((e) => e.summary === "Planning session")?.colorId;
  await expect.poll(color, { timeout: 45_000 }).toBe("2");
  await category.selectOption({ label: "Personal" });
  await expect.poll(color, { timeout: 45_000 }).toBe("3");
  await page.getByLabel("Category of Private").selectOption({ label: "Travel" });
  await expect.poll(color, { timeout: 45_000 }).toBe("5");
  await page.reload();
  await expect(page.getByLabel("Category of Private")).toHaveValue("travel");
});
