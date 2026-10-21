// Items that write to a calendar of a disconnected account
// (docs/specs/accounts-login-emails-permissions.md rule 16): habits, focus
// time, flexible meetings, task calendars and booking links show an error
// state and get no new events until the user reconnects the account. The CalDAV server stops
// taking the added account's stored password, the way a revoked Google token
// stops working.
//
// Ways it can fail, and the check that catches each:
// - new events go to the main calendar instead (the fallback)  -> no habit, meeting or chunk on the main calendar
// - the item shows no error                                    -> the "is disconnected" note on each item
// - a booking is written to another calendar                   -> the booker gets a refusal; no event anywhere
// - reconnect does not resume the items                        -> events on the added calendar after reconnect
// - focus time waits with no error                             -> the note on the automations list
// - the events of a waiting item change while it waits          -> its focus events, read on the server
// - the state is not stored                                    -> reload after each step
import type { Page } from "@playwright/test";
import type { ProviderEvent } from "../../src/server/providers/types.ts";
import { addDays } from "../../src/shared/time.ts";
import {
  automation,
  create,
  eventProp,
  openAutomations,
  rawEvent,
  save,
} from "./automation-list-helpers.ts";
import { week } from "./calendar-helpers.ts";
import { addCalDavAccount, openAccount } from "./delegation-helpers.ts";
import { at, BACKEND, blockUntil, eventually, expect, planNow, test } from "./fixtures.ts";
import { addLink, addTask, claimPage, slot, titled, visitor, W } from "./helpers.ts";
import { editLink, saveLink } from "./link-helpers.ts";
import { setPassword } from "./radicale-users.ts";

test.skip(BACKEND === "google", "The test changes a password on the loopback CalDAV server.");

const accountRow = (page: Page, email: string) =>
  page.getByTestId("account-list").locator(`[data-account="${email}"]`);
/** Booked events are not managed events: they carry the booker's name. */
const booked = (l: ProviderEvent[]) => l.filter((e) => e.summary.includes("Ann"));
const note = (email: string) =>
  `Waiting: ${email} is disconnected. Reconnect it on the Account page.`;

/** The server stops taking the added account's password; waits for "Disconnected". */
async function disconnect(page: Page, username: string, email: string): Promise<void> {
  setPassword(username, 6, `new-${Date.now()}`);
  await planNow(page);
  await openAccount(page);
  await expect
    .poll(
      async () => {
        await page.reload();
        return accountRow(page, email).getByTestId("account-status").textContent();
      },
      { timeout: 45_000 },
    )
    .toBe("Disconnected");
}

/** The server takes the first password again, and the user types it on the Account page. */
async function reconnect(
  page: Page,
  user: { username: string; password: string },
  email: string,
): Promise<void> {
  setPassword(user.username, 6, user.password);
  await openAccount(page);
  await accountRow(page, email).getByRole("button", { name: "Reconnect" }).click();
  const form = page.getByTestId("reconnect-form");
  await form.getByLabel(`Password for ${email}`).fill(user.password);
  await form.getByRole("button", { name: "Reconnect account" }).click();
  await expect(page.getByTestId("account-message")).toHaveText(`${email} is connected again.`);
}

test("habits, focus time, flexible meetings and task calendars that write to a disconnected account show an error and get no new events until reconnect (accounts rule 16)", async ({
  page,
  cal,
  signIn,
  people,
  radicale,
}) => {
  const six = radicale?.users[6];
  if (!radicale || !six) throw new Error("This test needs the CalDAV backend.");
  const extra = await people(6);
  const theirs = `Work (${extra.email})`;
  try {
    await blockUntil(cal, W);
    await signIn();
    await addCalDavAccount(page, { ...six, email: extra.email });
    await expect(accountRow(page, extra.email).getByTestId("account-status")).toHaveText(
      "Connected",
    );

    // A habit and a meeting on the added account's calendar, then off for now.
    await page.getByRole("link", { name: "Habits" }).click();
    const form = page.getByTestId("habit-form");
    await form.getByLabel("Title").fill("Stretch");
    await form.getByLabel("Ideal time").fill("09:00");
    // The habit form names calendars without their account: the added one is listed last.
    const calendar = form.getByLabel("Calendar", { exact: true });
    await expect(calendar.locator("option")).toHaveCount(3);
    await calendar.selectOption(
      (await calendar.locator("option").last().getAttribute("value")) ?? "",
    );
    await form.getByRole("button", { name: "Add habit" }).click();
    const habit = page.locator('[data-habit-title="Stretch"]');
    await expect(habit).toBeVisible();
    await page.getByRole("link", { name: "Meetings" }).click();
    const mform = page.getByTestId("meeting-form");
    await mform.getByLabel("Title").fill("Sync");
    await mform.getByLabel("Guests (comma list)", { exact: true }).fill("dana@example.com");
    await mform.getByLabel("Guests (comma list)", { exact: true }).blur();
    await mform.getByLabel("Calendar", { exact: true }).selectOption({ label: theirs });
    await mform.getByRole("button", { name: "Add meeting" }).click();
    const meeting = page.locator('[data-meeting-title="Sync"]');
    await expect(meeting).toBeVisible();
    // Focus time on the added account's calendar; it stays on. The habit's
    // time counts toward the goal, so the goal is larger than the habit.
    const focusForm = await create(page, "Focus time");
    await focusForm.getByLabel("Title").fill("Deep work");
    await focusForm.getByLabel("Weekly goal (hours)").fill("10");
    await focusForm.getByLabel("Daily minimum (hours)").fill("0");
    await focusForm.getByLabel("Daily maximum (hours)").fill("3");
    const focusCalendar = focusForm.getByLabel("Calendar", { exact: true });
    await expect(focusCalendar.locator("option")).toHaveCount(3);
    await focusCalendar.selectOption(
      (await focusCalendar.locator("option").last().getAttribute("value")) ?? "",
    );
    await save(focusForm);
    const focus = automation(page, "Deep work");
    await expect(focus).toBeVisible();
    await expect(focus.getByTestId("calendar-disconnected")).toHaveCount(0);
    await eventually(
      () => week(extra.cal),
      (l) => {
        expect(titled(l, "Stretch").length).toBeGreaterThan(0);
        expect(titled(l, "Sync")).toHaveLength(1);
        expect(titled(l, "Deep work").length).toBeGreaterThan(0);
      },
    );
    await page.getByRole("link", { name: "Meetings" }).click();
    await meeting.getByRole("button", { name: "Turn off" }).click();
    await expect(meeting).toContainText("Turn on");
    await page.getByRole("link", { name: "Habits" }).click();
    await habit.getByRole("button", { name: "Turn off" }).click();
    await expect(habit.getByRole("button", { name: "Turn on" })).toBeVisible();
    // Task chunks of the work hours go to the added account's calendar.
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    const work = page.getByTestId("hours-work");
    await work.getByLabel("Calendar for task chunks").selectOption({ label: "Work" });
    await expect(work.getByLabel("Calendar for task chunks")).toHaveValue(/.+/);
    await eventually(
      () => week(extra.cal),
      (l) => expect(titled(l, "Stretch").length + titled(l, "Sync").length).toBe(0),
    );

    // The focus events as the server has them; read again while the account is disconnected.
    await planNow(page);
    const focusEvents = async (ids: string[]) =>
      Promise.all(
        ids.map(async (id) => {
          const ics = await rawEvent(id);
          return [id, eventProp(ics, "DTSTART"), eventProp(ics, "DTEND")];
        }),
      );
    const focusBefore = await focusEvents(
      titled(await week(extra.cal), "Deep work").map((e) => e.id),
    );
    expect(focusBefore.length).toBeGreaterThan(0);
    await disconnect(page, six.username, extra.email);
    await openAutomations(page);
    await expect(focus.getByTestId("calendar-disconnected")).toHaveText(note(extra.email));

    // Turned on while the account is disconnected: no events anywhere, and an error.
    await page.getByRole("link", { name: "Habits" }).click();
    await habit.getByRole("button", { name: "Turn on" }).click();
    await expect(habit.getByTestId("calendar-disconnected")).toHaveText(note(extra.email));
    await page.getByRole("link", { name: "Meetings" }).click();
    await meeting.getByRole("button", { name: "Turn on" }).click();
    await expect(meeting.getByTestId("calendar-disconnected")).toHaveText(note(extra.email));
    await addTask(page, { title: "Report", minutes: 60, split: false, due: "" });
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    await expect(work.getByTestId("calendar-disconnected")).toHaveText(note(extra.email));
    await planNow(page);
    await planNow(page);
    const main = await week(cal);
    expect(titled(main, "Stretch")).toHaveLength(0);
    expect(titled(main, "Sync")).toHaveLength(0);
    expect(titled(main, "Report")).toHaveLength(0);
    expect(titled(main, "Deep work")).toHaveLength(0);
    // The waiting focus time's events stay as they are.
    expect(await focusEvents(focusBefore.map(([id]) => id ?? ""))).toEqual(focusBefore);
    await page.reload();
    await expect(work.getByTestId("calendar-disconnected")).toHaveText(note(extra.email));
    await openAutomations(page);
    await expect(focus.getByTestId("calendar-disconnected")).toHaveText(note(extra.email));
    await page.getByRole("link", { name: "Habits" }).click();
    await expect(habit.getByTestId("calendar-disconnected")).toHaveText(note(extra.email));

    // Reconnect: the items get their events on the added calendar, and the errors go.
    await reconnect(page, six, extra.email);
    await eventually(
      () => week(extra.cal),
      (l) => {
        expect(titled(l, "Stretch").length).toBeGreaterThan(0);
        expect(titled(l, "Sync")).toHaveLength(1);
        expect(titled(l, "Report")).toHaveLength(1);
      },
    );
    const after = await week(cal);
    expect(titled(after, "Stretch").length + titled(after, "Sync").length).toBe(0);
    expect(titled(after, "Report")).toHaveLength(0);
    expect(titled(after, "Deep work")).toHaveLength(0);
    expect(titled(await week(extra.cal), "Deep work").length).toBeGreaterThan(0);
    await page.reload();
    await page.getByRole("link", { name: "Habits" }).click();
    await expect(habit).toBeVisible();
    await expect(habit.getByTestId("calendar-disconnected")).toHaveCount(0);
    await page.getByRole("link", { name: "Meetings" }).click();
    await expect(meeting).toBeVisible();
    await expect(meeting.getByTestId("calendar-disconnected")).toHaveCount(0);
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    await expect(work).toBeVisible();
    await expect(work.getByTestId("calendar-disconnected")).toHaveCount(0);
    await openAutomations(page);
    await expect(focus).toBeVisible();
    await expect(focus.getByTestId("calendar-disconnected")).toHaveCount(0);
  } finally {
    setPassword(six.username, 6, six.password);
  }
});

test("a booking link whose calendar is on a disconnected account shows an error and refuses bookings until reconnect (accounts rule 16)", async ({
  page,
  browser,
  cal,
  signIn,
  people,
  radicale,
}) => {
  const six = radicale?.users[6];
  if (!radicale || !six) throw new Error("This test needs the CalDAV backend.");
  const extra = await people(6);
  const theirs = `Work (${extra.email})`;
  const tue = addDays(W, 1);
  try {
    await blockUntil(cal, W);
    await signIn();
    await addCalDavAccount(page, { ...six, email: extra.email });
    await expect(accountRow(page, extra.email).getByTestId("account-status")).toHaveText(
      "Connected",
    );
    await claimPage(page, "zed");
    await addLink(page, { title: "Chat", durations: "30" });
    const ed = await editLink(page, "Chat");
    await ed.getByLabel("Calendar for booked events").selectOption({ label: theirs });
    await saveLink(page);
    const link = page.locator('[data-link-title="Chat"]');

    await disconnect(page, six.username, extra.email);
    // The link's error (accounts rules 16, 19): one message, with the account.
    const why = `Paused: ${extra.email} is disconnected. Reconnect it on the Account page, or choose another account for booked events.`;
    await page.getByRole("link", { name: "Booking links" }).click();
    await expect(link.getByTestId("link-target-error")).toHaveText(why);
    await expect(link.getByTestId("calendar-disconnected")).toHaveCount(0);
    await page.reload();
    await expect(link.getByTestId("link-target-error")).toHaveText(why);

    // A booker is refused: the page offers no times; no event is written to any calendar.
    const v = await visitor(browser);
    await v.goto("/book/zed/chat");
    await expect(v.getByTestId("paused")).toHaveText(
      "This link takes no bookings right now. Ask the organizer for another way to meet.",
    );
    await expect(v.getByTestId("times")).toHaveCount(0);
    expect(booked(await week(cal))).toHaveLength(0);

    // Reconnect: the error goes and the booking goes to the added calendar.
    await reconnect(page, six, extra.email);
    await page.getByRole("link", { name: "Booking links" }).click();
    await expect(link).toBeVisible();
    await expect(link.getByTestId("link-target-error")).toHaveCount(0);
    await expect(link.getByTestId("calendar-disconnected")).toHaveCount(0);
    await v.goto("/book/zed/chat");
    await slot(v, at(tue, "10:00")).click();
    const form = v.getByTestId("book-form");
    await form.getByLabel("Your name").fill("Ann");
    await form.getByLabel("Your email").fill("ann@example.com");
    await form.getByRole("button", { name: "Book" }).click();
    await expect(v.getByTestId("booked")).toBeVisible();
    await eventually(
      () => week(extra.cal),
      (l) => expect(booked(l)).toHaveLength(1),
    );
    expect(booked(await week(cal))).toHaveLength(0);
  } finally {
    setPassword(six.username, 6, six.password);
  }
});
