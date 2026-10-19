// Booking emails: the confirmation, update and cancel emails to the booker and
// the organizers, their branding, and the reminder before the meeting.
// Specs: booking-links.md rules 14, 16, 18, 21 and edge case 7;
// booking-links-booking-page.md rules 19-23, 25 and 31.
//
// Ways this can fail:
//  1. No email on booking, reschedule or cancel, or the booker or the organizer gets none.
//  2. The booker's email shows the time in another zone than the one the booker
//     chose on the page; the organizer's email is not in the calendar zone.
//  3. The booker's email lacks the reschedule or the cancel link, or a link does
//     not open that action; the organizer's email carries them.
//  4. An email misses the title, the location, the booker's message or the answers.
//  5. Emails ignore the link's branding: a custom link shows no team logo or no
//     homepage link, the logo URL does not load from outside, or a link set to
//     none shows a logo.
//  6. The reminder goes out before its time, not at its time, twice, for a
//     cancelled booking, to the organizer, or without the message.
//  7. A booking that existed when the reminder was turned on never gets one;
//     the setting is lost on reload.
//  8. An email or the reminder names the link's default location instead of
//     the one the booker chose; CC guests get no email, or an organizer in CC
//     gets a second copy.
import type { Page } from "@playwright/test";
import { addDays, HOUR, MINUTE, utcToLocal } from "../../src/shared/time.ts";
import {
  at,
  BASE_URL,
  blockUntil,
  EMAIL,
  eventually,
  expect,
  local,
  test,
  ZONE,
} from "./fixtures.ts";
import { addLink, allEvents, book, claimPage, slot, visitor, W } from "./helpers.ts";
import { editLink, saveLink } from "./link-helpers.ts";
import { openTeam } from "./team-helpers.ts";

const day = (n: number) => addDays(W, n);
const NY = "America/New_York";
const hm = (zone: string, t: number) => {
  const m = utcToLocal(zone, t).minuteOfDay;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

test("booking, reschedule and cancel email the booker and the organizer, each in their own time zone, with the actions for the booker only (rules 14, 16, 18; page rules 19-21)", async ({
  page,
  browser,
  cal,
  signIn,
  mail,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await claimPage(page, "uli");
  await addLink(page, { title: "Consult", durations: "30" });
  const ed = await editLink(page, "Consult");
  await ed.getByLabel("Location").fill("Main street 1");
  await ed.getByRole("button", { name: "+ Add question" }).click();
  await ed.getByLabel("Question 1", { exact: true }).fill("Company");
  await saveLink(page);

  const v = await visitor(browser);
  await v.goto(`/book/uli/consult?tz=${NY}`);
  const t1 = at(day(1), "10:00");
  await slot(v, t1).click();
  const form = v.getByTestId("book-form");
  await form.getByLabel("Your name").fill("Vic");
  await form.getByLabel("Your email").fill("vic@example.com");
  await form.getByLabel(/^Message/).fill("See you soon");
  await form.getByLabel("Company").fill("Acme");
  await form.getByRole("button", { name: "Book" }).click();
  await expect(v.getByTestId("booked")).toBeVisible();

  const booked = await mail.message("vic@example.com", /^Booked: Consult/);
  expect(booked.text).toContain(`${hm(NY, t1)} to ${hm(NY, t1 + 30 * MINUTE)} (${NY})`);
  expect(booked.text).toContain("Main street 1");
  const resched = /https?:\/\/\S+\/book\/manage\/\S+\?action=reschedule/.exec(booked.text)?.[0];
  const cancel = /https?:\/\/\S+\/book\/manage\/\S+\?action=cancel/.exec(booked.text)?.[0];
  expect(resched).toBeTruthy();
  expect(cancel).toBeTruthy();
  const told = await mail.message(EMAIL, /^New booking: Consult with Vic/);
  expect(told.text).toContain(`${hm(ZONE, t1)} to ${hm(ZONE, t1 + 30 * MINUTE)} (${ZONE})`);
  expect(told.text).toContain("vic@example.com");
  expect(told.text).toContain("See you soon");
  expect(told.text).toContain("Company\nAcme");
  expect(told.text).toContain("Main street 1");
  expect(told.text).not.toContain("/book/manage/");

  // The reschedule link of the email opens reschedule mode.
  await v.goto(resched ?? "");
  await expect(v.getByTestId("manage-page")).toBeVisible();
  const t2 = at(day(2), "11:00");
  await slot(v, t2).click();
  await expect(v.getByText("Your booking has a new time.")).toBeVisible();
  const moved = await mail.message("vic@example.com", /^Rescheduled: Consult/);
  expect(moved.text).toContain(`${hm(NY, t2)} to ${hm(NY, t2 + 30 * MINUTE)} (${NY})`);
  expect(moved.text).toMatch(/\?action=cancel/);
  const toldMoved = await mail.message(EMAIL, /^Rescheduled: Consult with Vic/);
  expect(toldMoved.text).toContain(`${hm(ZONE, t2)} to`);
  expect(toldMoved.text).not.toContain("/book/manage/");
  await eventually(
    () => allEvents(cal),
    (l) =>
      expect(local(l.find((e) => e.summary === "Consult with Vic")?.start ?? 0)).toBe(local(t2)),
  );

  // The cancel link asks first, then cancels.
  await v.goto(cancel ?? "");
  await expect(v.getByTestId("cancel-confirm")).toBeVisible();
  await expect(v.getByTestId("booking-status")).not.toHaveText("Cancelled");
  await v.getByRole("button", { name: "Cancel booking" }).click();
  await expect(v.getByTestId("booking-status")).toHaveText("Cancelled");
  await mail.message("vic@example.com", /^Cancelled: Consult/);
  await mail.message(EMAIL, /^Cancelled: Consult with Vic/);
  await eventually(
    () => allEvents(cal),
    (l) => expect(l.find((e) => e.summary === "Consult with Vic")).toBeUndefined(),
  );
  await v.reload();
  await expect(v.getByTestId("booking-status")).toHaveText("Cancelled");
  expect(await mail.count("vic@example.com")).toBe(3);
  expect(await mail.count(EMAIL)).toBe(3);
});

test("booking emails use the link's branding: the team logo with the homepage link, or no logo (page rules 23, 25, 31)", async ({
  page,
  browser,
  cal,
  signIn,
  mail,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await openTeam(page);
  const br = page.getByTestId("team-branding");
  await br
    .getByLabel(/^Logo/)
    .setInputFiles({ name: "logo.png", mimeType: "image/png", buffer: PNG });
  await expect(br.getByTestId("logo-preview")).toBeVisible();
  await br.getByLabel("Homepage URL").fill("https://example.com/home");
  await br.getByRole("button", { name: "Save branding" }).click();
  await expect(br.getByTestId("branding-saved")).toBeVisible();
  await claimPage(page, "vera");
  await editLink(page, "Meeting");
  await page.getByTestId("link-editor").getByLabel("Branding").selectOption("custom");
  await saveLink(page);
  await editLink(page, "Quick meeting");
  await page.getByTestId("link-editor").getByLabel("Branding").selectOption("none");
  await saveLink(page);

  const v = await visitor(browser);
  await v.goto("/book/vera/meeting");
  await book(v, at(W, "10:00"), "Wes", "wes@example.com");
  await v.goto("/book/vera/quick-meeting");
  await book(v, at(W, "11:00"), "Xia", "xia@example.com");

  const custom = await mail.message("wes@example.com", /^Booked: Meeting/);
  const logo = /<img[^>]+src="([^"]+\/pub\/branding\/[^"]+\/logo[^"]*)"/.exec(custom.html)?.[1];
  expect(logo?.startsWith(`${BASE_URL}/pub/branding/`)).toBe(true);
  expect(custom.html).toContain('href="https://example.com/home"');
  const res = await fetch(logo ?? "");
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("image/png");
  const told = await mail.message(EMAIL, /^New booking: Meeting with Wes/);
  expect(told.html).toContain(`${BASE_URL}/pub/branding/`);

  const plain = await mail.message("xia@example.com", /^Booked: Quick meeting/);
  expect(plain.html).toContain("Quick meeting");
  expect(plain.html).not.toContain("<img");
  expect(plain.html).not.toContain("example.com/home");

  await page.reload();
  await editLink(page, "Meeting");
  await expect(page.getByTestId("link-editor").getByLabel("Branding")).toHaveValue("custom");
});

test("the reminder email reaches the booker once at its time with the message; a booking made before the setting gets it, a cancelled one never (rule 21)", async ({
  page,
  browser,
  cal,
  signIn,
  mail,
  app,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await claimPage(page, "wyn");
  await addLink(page, { title: "Session", durations: "30" });
  const v = await visitor(browser);
  // Booking A exists before the reminder is turned on; booking C is cancelled.
  const tA = at(day(1), "10:00");
  const tB = at(day(2), "10:00");
  const tC = at(day(3), "10:00");
  await v.goto("/book/wyn/session");
  await book(v, tA, "Ann", "ann@example.com");
  await mail.message("ann@example.com", /^Booked: Session/);
  await v.goto("/book/wyn/session");
  await book(v, tC, "Cid", "cid@example.com");
  await v.getByTestId("manage-link").click();
  await v.getByRole("button", { name: "Cancel booking" }).click();
  await expect(v.getByTestId("booking-status")).toHaveText("Cancelled");
  await mail.message("cid@example.com", /^Cancelled: Session/);
  await mail.message(EMAIL, /^Cancelled: Session with Cid/);

  let ed = await editLink(page, "Session");
  await ed.getByLabel("Send a reminder email").check();
  await ed.getByLabel("Hours before").fill("24");
  await ed.getByLabel("Reminder message").fill("Bring your questions.");
  await saveLink(page);
  await page.reload();
  ed = await editLink(page, "Session");
  await expect(ed.getByLabel("Send a reminder email")).toBeChecked();
  await expect(ed.getByLabel("Hours before")).toHaveValue("24");
  await expect(ed.getByLabel("Reminder message")).toHaveValue("Bring your questions.");

  // Booking B is made after the setting.
  await v.goto("/book/wyn/session");
  await book(v, tB, "Bo", "bo@example.com");
  await mail.message("bo@example.com", /^Booked: Session/);
  await mail.message(EMAIL, /^New booking: Session with Bo/);

  const remind = (t: number) =>
    app.cli("booking-reminders", "--now", new Date(t).toISOString()).trim();
  expect(remind(tA - 24 * HOUR - 5 * MINUTE)).toBe("sent 0 reminders");
  expect(await mail.count("ann@example.com")).toBe(1);
  expect(remind(tA - 24 * HOUR + MINUTE)).toBe("sent 1 reminder");
  const reminder = await mail.message("ann@example.com", /^Reminder: Session/);
  expect(reminder.text).toContain("Bring your questions.");
  expect(reminder.text).toContain(`${hm(ZONE, tA)} to ${hm(ZONE, tA + 30 * MINUTE)} (${ZONE})`);
  expect(remind(tA - 24 * HOUR + 2 * MINUTE)).toBe("sent 0 reminders");
  expect(remind(tB - 24 * HOUR + MINUTE)).toBe("sent 1 reminder");
  await mail.message("bo@example.com", /^Reminder: Session/);
  expect(remind(tC - 24 * HOUR + MINUTE)).toBe("sent 0 reminders");

  expect(await mail.count("ann@example.com")).toBe(2);
  expect(await mail.count("bo@example.com")).toBe(2);
  expect(await mail.count("cid@example.com")).toBe(2);
  // The organizer got three "New booking" emails and one "Cancelled", no reminder.
  expect(await mail.count(EMAIL)).toBe(4);
});

/** A link "Tour" with two locations, Room A (default) and Room B, and a reminder 24 hours before. */
async function tourLink(page: Page, pageName: string) {
  await claimPage(page, pageName);
  await addLink(page, { title: "Tour", durations: "30" });
  const ed = await editLink(page, "Tour");
  await ed.getByLabel("Location 1").fill("Room A");
  await ed.getByRole("button", { name: "+ Add location" }).click();
  await ed
    .getByTestId("location-2")
    .getByLabel("Kind")
    .selectOption({ label: "Other (text or URL)" });
  await ed.getByLabel("Location 2").fill("Room B");
  await ed.getByLabel("Send a reminder email").check();
  await ed.getByLabel("Hours before").fill("24");
  await ed.getByLabel("Reminder message").fill("See you there.");
  await saveLink(page);
}

/** Books Room B at `t` as Dee, with the given CC list. */
async function bookRoomB(v: Page, t: number, cc: string) {
  await slot(v, t).click();
  const form = v.getByTestId("book-form");
  await form.getByLabel("Location").selectOption({ label: "Other: Room B" });
  if (cc) await form.getByLabel(/^CC/).fill(cc);
  await form.getByLabel("Your name").fill("Dee");
  await form.getByLabel("Your email").fill("dee@example.com");
  await form.getByRole("button", { name: "Book" }).click();
  await expect(v.getByTestId("booked-location")).toHaveText("Location: Room B");
}

test("the reminder names the location the booker chose, not the link's default (rule 21; page details form)", async ({
  page,
  browser,
  cal,
  signIn,
  mail,
  app,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await tourLink(page, "cora");
  const v = await visitor(browser);
  await v.goto("/book/cora/tour");
  const t1 = at(day(1), "10:00");
  await bookRoomB(v, t1, "");
  const booked = await mail.message("dee@example.com", /^Booked: Tour/);
  expect(booked.text).toContain("Location: Room B");
  const remind = () =>
    app.cli("booking-reminders", "--now", new Date(t1 - 24 * HOUR + MINUTE).toISOString()).trim();
  expect(remind()).toBe("sent 1 reminder");
  const reminder = await mail.message("dee@example.com", /^Reminder: Tour/);
  expect(reminder.text).toContain("See you there.");
  expect(reminder.text).toContain("Location: Room B");
  expect(reminder.text).not.toContain("Room A");
  expect(remind()).toBe("sent 0 reminders");
});

test("CC guests get the booked, rescheduled and cancelled emails with the chosen location and without the booker's links; an organizer in CC gets no second copy (rule 14; page details form)", async ({
  page,
  browser,
  cal,
  signIn,
  mail,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await tourLink(page, "cyd");
  const v = await visitor(browser);
  await v.goto("/book/cyd/tour");
  const t1 = at(day(1), "10:00");
  await bookRoomB(v, t1, `Cy@Example.com, ${EMAIL.toUpperCase()}`);

  const ccBooked = await mail.message("cy@example.com", /^Booked: Tour/);
  expect(ccBooked.text).toContain("Location: Room B");
  expect(ccBooked.text).toContain(`${hm(ZONE, t1)} to ${hm(ZONE, t1 + 30 * MINUTE)} (${ZONE})`);
  expect(ccBooked.text).not.toContain("/book/manage/");
  const told = await mail.message(EMAIL, /^New booking: Tour with Dee/);
  expect(told.text).toContain("Location: Room B");

  await v.getByTestId("manage-link").click();
  await v.getByRole("button", { name: "Reschedule" }).click();
  await slot(v, at(day(2), "11:00")).click();
  await expect(v.getByText("Your booking has a new time.")).toBeVisible();
  const moved = await mail.message("cy@example.com", /^Rescheduled: Tour/);
  expect(moved.text).toContain("Location: Room B");
  expect(moved.text).not.toContain("/book/manage/");
  await v.reload();
  await v.getByRole("button", { name: "Cancel booking" }).click();
  await expect(v.getByTestId("booking-status")).toHaveText("Cancelled");
  await mail.message("cy@example.com", /^Cancelled: Tour/);
  await mail.message(EMAIL, /^Cancelled: Tour with Dee/);
  await v.reload();
  await expect(v.getByTestId("booking-status")).toHaveText("Cancelled");
  expect(await mail.count("cy@example.com")).toBe(3);
  expect(await mail.count("dee@example.com")).toBe(3);
  // The organizer in CC gets the organizer's emails only.
  expect(await mail.count(EMAIL)).toBe(3);
});
