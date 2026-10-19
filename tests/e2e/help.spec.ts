// Troubleshooting (docs/specs/support-troubleshooting.md): the help index and
// its fix pages, the event lookup with Tempoloom's change log, and the advice
// to turn off other scheduling tools (platform-current-version.md rule 17).
//
// Ways this can fail, each covered below:
// - a group or entry of the index is missing, or a link leads nowhere (also on reload);
// - a fix page gives its steps in the wrong order or drops the warning;
// - the lookup cannot read a CalDAV event link, finds the wrong event, or misnames
//   the copy's policy and source;
// - a skipped source event does not say why;
// - a write by Tempoloom leaves no change log entry, or the entry has no reason or time;
// - a malformed link, or a link to a calendar the user did not add, gives no clear message;
// - the onboarding advice does not show for a new user, or comes back after dismissal.
import type { Page } from "@playwright/test";
import { addDays } from "../../src/shared/time.ts";
import {
  at,
  BACKEND,
  blockUntil,
  type CalendarDriver,
  eventually,
  expect,
  test,
} from "./fixtures.ts";
import { W } from "./helpers.ts";

const tue = addDays(W, 1);
const week = (cal: CalendarDriver) => cal.events(at(W, "00:00"), at(addDays(W, 7), "00:00"));
const copies = (evs: Awaited<ReturnType<typeof week>>) =>
  evs.filter((e) => e.privateProps.tl === "1" && e.privateProps.tl_key?.startsWith("mirror:"));

async function openHelp(page: Page): Promise<void> {
  await page.getByRole("link", { name: "Help", exact: true }).click();
  await expect(page.getByTestId("help-index")).toBeVisible();
}

async function lookUp(page: Page, q: string): Promise<void> {
  const form = page.getByTestId("lookup-form");
  await form.getByLabel("Event link or id").fill(q);
  await form.getByRole("button", { name: "Look up" }).click();
}

test("the help index groups common problems and links each to its fix (SPEC-SUPPORT-01 rules 1-6, 17-20)", async ({
  page,
  signIn,
}) => {
  await signIn();
  await openHelp(page);
  const index = page.getByTestId("help-index");
  const groups = [
    "Flexible meetings",
    "Booking links",
    "Calendar mirroring",
    "Focus time",
    "Tasks",
    "Buffers",
    "Settings and colors",
    "General",
    "Contact support",
  ];
  await expect(index.getByRole("heading", { level: 2 })).toHaveText(groups);
  const group = (name: string) => index.locator("section", { hasText: name });
  for (const entry of [
    "Copies are missing",
    "Copies appear twice",
    "Copies miss details",
    "Repair one event",
  ])
    await expect(group("Calendar mirroring").getByRole("link", { name: entry })).toBeVisible();
  for (const entry of [
    "An item does not get placed",
    "Events are placed at the wrong hours",
    "Alerts for copies on Apple devices",
    "Events come back after you delete them",
    "Turn off other scheduling tools",
  ])
    await expect(group("General").getByRole("link", { name: entry })).toBeVisible();
  await expect(group("Contact support")).toContainText("Ask the person who runs this server");

  // Missing copies: first the off-and-on toggle, then the event link to support; and the warning.
  await group("Calendar mirroring").getByRole("link", { name: "Copies are missing" }).click();
  const page1 = page.getByTestId("help-page");
  await expect(page1.getByRole("heading", { level: 1 })).toHaveText("Copies are missing");
  const steps = page1.locator("ol > li");
  await expect(steps).toHaveCount(2);
  await expect(steps.nth(0)).toContainText("Turn the mirroring off");
  await expect(steps.nth(0)).toContainText("turn it on again");
  await expect(steps.nth(1)).toContainText("event link");
  await expect(page1).toContainText("slow down your account");
  await page.reload();
  await expect(page.getByTestId("help-page").getByRole("heading", { level: 1 })).toHaveText(
    "Copies are missing",
  );
  await page
    .getByTestId("help-page")
    .getByRole("link", { name: "Calendar mirroring settings" })
    .click();
  await expect(page.getByTestId("mirror-form")).toBeVisible();

  // Apple devices: copies never alert, and the three device steps in order.
  await openHelp(page);
  await group("General").getByRole("link", { name: "Alerts for copies on Apple devices" }).click();
  const apple = page.getByTestId("help-page");
  await expect(apple).toContainText("Copies never alert");
  const appleSteps = apple.locator("ol > li");
  await expect(appleSteps).toHaveCount(3);
  await expect(appleSteps.nth(0)).toContainText("default alert time");
  await expect(appleSteps.nth(1)).toContainText("delete its local data");
  await expect(appleSteps.nth(2)).toContainText("full download");

  // Events that come back: how to stop each kind for good.
  await openHelp(page);
  await group("General")
    .getByRole("link", { name: "Events come back after you delete them" })
    .click();
  const back = page.getByTestId("help-page");
  await expect(back).toContainText("Tempoloom treats a deleted event as a skip");
  for (const [kind, fix] of [
    ["Habit", "turn the habit off"],
    ["Focus time", "turn focus time off"],
    ["Task", "mark it done"],
    ["Mirrored copy", "#tl_nosync"],
  ] as const) {
    await expect(back.locator("li", { hasText: kind })).toContainText(fix);
  }
  await page.reload();
  await expect(page.getByTestId("help-page")).toContainText("#tl_nosync");
});

test("looking up an event by its link shows what Tempoloom knows and its change log (SPEC-SUPPORT-01 rules 7-12, AT-1 to AT-3)", async ({
  page,
  cal,
  signIn,
}) => {
  test.skip(BACKEND === "google", "The lookup E2E uses CalDAV event links.");
  await blockUntil(cal, W);
  await signIn();
  const personal = await cal.newCalendar("Personal");
  const dentist = await personal.addEvent({
    title: "Dentist",
    start: at(tue, "10:00"),
    end: at(tue, "11:00"),
  });
  const gym = await personal.addEvent({
    title: "Gym #tl_nosync",
    start: at(tue, "07:00"),
    end: at(tue, "08:00"),
  });
  const board = await cal.addEvent({
    title: "Board",
    start: at(tue, "16:00"),
    end: at(tue, "17:00"),
  });

  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Refresh calendar list" }).click();
  await expect(page.getByTestId("calendar-list")).toContainText("Personal");
  const form = page.getByTestId("mirror-form");
  await form.getByLabel("Copy events from").selectOption({ label: "Personal" });
  await form.getByLabel("To").selectOption({ label: "Work" });
  await form.getByLabel("Copies show").selectOption({ label: "A label only" });
  await form.getByRole("button", { name: "Add mirroring" }).click();
  await expect(page.getByTestId("mirror-list")).toContainText("Personal → Work");
  const [copy] = copies(
    await eventually(
      () => week(cal),
      (l) => expect(copies(l)).toHaveLength(1),
    ),
  );
  if (!copy) throw new Error("no copy");

  // AT-1: the copy's link names the policy and the source event.
  await openHelp(page);
  await page.getByTestId("help-index").getByRole("link", { name: "Repair one event" }).click();
  await expect(page.getByTestId("lookup-form")).toBeVisible();
  await lookUp(page, copy.id);
  const result = page.getByTestId("lookup-result");
  await expect(result).toContainText("Copy made by calendar mirroring Personal → Work");
  await expect(result).toContainText("Source event: “Dentist” on Personal");
  await expect(result).toContainText("Calendar: Work");
  await expect(result).toContainText("Last read");
  const log = result.getByTestId("change-entry");
  await expect(log).toHaveCount(1);
  await expect(log.first()).toContainText("create");
  await expect(log.first()).toContainText("source copied");

  // AT-2: a skipped source event says which policy skipped it and why.
  await lookUp(page, gym);
  await expect(result).toContainText("Tempoloom does not manage this event");
  await expect(result).toContainText("Personal → Work: skipped");
  await expect(result).toContainText("#tl_nosync");
  await lookUp(page, dentist);
  await expect(result).toContainText("Personal → Work: copied");

  // An event Tempoloom never touched names its calendar (edge case 3).
  await lookUp(page, board);
  await expect(result).toContainText("Tempoloom does not manage this event");
  await expect(result).toContainText("Calendar: Work");
  await expect(result.getByTestId("change-entry")).toHaveCount(0);

  // A malformed link, and a link to a calendar the user did not add (edge cases 1, 2).
  await lookUp(page, "https://example.com/not-an-event");
  await expect(page.getByRole("alert")).toContainText("cannot read this link");
  await lookUp(page, copy.id.replace(/\/[^/]+\/([^/]+)$/, "/unknown-calendar/$1"));
  await expect(page.getByRole("alert")).toContainText("cannot see that calendar");

  // AT-3: the source moves; the copy's change log gets an update with the reason and new time.
  await personal.update(dentist, { start: at(tue, "14:00"), end: at(tue, "15:00") });
  await eventually(
    () => week(cal),
    (l) => expect(copies(l)[0]?.start).toBe(at(tue, "14:00")),
  );
  await lookUp(page, copy.id);
  await expect(result.getByTestId("change-entry")).toHaveCount(2);
  const update = result.getByTestId("change-entry").first();
  await expect(update).toContainText("update");
  await expect(update).toContainText("source moved");
  await expect(update).toContainText(`${tue} 14:00–15:00`);
  await page.reload();
  await expect(page.getByTestId("lookup-result").getByTestId("change-entry").first()).toContainText(
    "source moved",
  );
});

test("a new user sees the advice to turn off other scheduling tools until they dismiss it (SPEC-PLATFORM rule 17)", async ({
  page,
  signIn,
}) => {
  await signIn();
  const hint = page.getByTestId("hint-other-tools");
  await expect(hint).toContainText("turn off any other scheduling tool");
  await hint.getByRole("link", { name: "Why" }).click();
  await expect(page.getByTestId("help-page").getByRole("heading", { level: 1 })).toHaveText(
    "Turn off other scheduling tools",
  );
  await page.getByRole("link", { name: "Planner" }).click();
  await expect(hint).toBeVisible();
  await hint.getByRole("button", { name: "Got it" }).click();
  await expect(hint).toHaveCount(0);
  await page.reload();
  // The hints have loaded, and the dismissed one is not among them.
  await expect(page.getByTestId("planner-hints")).toHaveAttribute("data-loaded", "true");
  await expect(hint).toHaveCount(0);
});
