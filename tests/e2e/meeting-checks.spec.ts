// Meeting checks (docs/specs/automations-meeting-quality.md): the built-in
// checks, their defaults, ignore, the planner Issues tab, the daily digest,
// company checks, agenda drafts (library entry 4) and the recommendations list
// (platform-current-version.md rule 5).
//
// Ways it can fail, and the test that catches each:
// - a check misses its case: two accepted meetings that overlap, a guest who
//   declined, a guest (a user here) who is busy, an invitation with no answer,
//   a meeting with guests and no video link                        -> built-in checks
// - a check raises a false issue: a free event, a declined invitation, an
//   all-day event over a meeting, a link in the location, description or
//   CONFERENCE property, a street address as the location           -> built-in checks
// - a check edits or moves an event                                 -> built-in checks
// - an issue stays after its condition ends (an answer, a new link)  -> built-in checks
// - checks are off for a new user                                   -> ignore and disable
// - "ignore this event" hides other events, "ignore the series" misses
//   an occurrence, or an ignore is lost after a reload              -> ignore and disable
// - a disabled check keeps its open issues or raises new ones       -> ignore and disable
// - the digest does not come at its time, lists ignored issues or misses
//   open ones, or the next one is not moved to the next day          -> digest
// - library entry 9 does not turn the checks and the digest on, or shows no
//   "Added" badge                                                   -> digest
// - a member can change a company check, the issue reaches a guest who
//   does not organize the meeting, or a member cannot ignore it      -> company checks
// - an agenda draft is written before the user applies it, or not at all;
//   the no-agenda issue stays after the apply                       -> agenda drafts
// - the recommendations miss a skipped habit, an unmet focus goal or a day
//   with too many meetings                                          -> agenda drafts
import { addDays, utcToLocal } from "../../src/shared/time.ts";
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
  ZONE,
} from "./fixtures.ts";
import { addHabit, W } from "./helpers.ts";
import { allDayBusy, invitation } from "./ics.ts";
import {
  dailyMail,
  issue,
  openChecks,
  openIssues,
  putMeeting,
  rawEvent,
  soon,
} from "./meeting-helpers.ts";
import { teamOfTwo } from "./team-helpers.ts";

test.skip(BACKEND === "google", "Meeting check E2E writes guests and answers on CalDAV.");

const today = () => utcToLocal(ZONE, Date.now()).date;
const T1 = () => addDays(today(), 1);
const T2 = () => addDays(today(), 2);
const LONG = { timeout: 60_000 };
const ZOOM = "Join https://zoom.us/j/123456789";

test("each built-in check raises its issue in the planner Issues tab, never changes an event, and an issue resolves when its condition ends (checks conflict, attendee_availability, rsvp_reminder, video_link; rules 5-7)", async ({
  page,
  cal,
  signIn,
  colleague,
}) => {
  const t1 = T1();
  const t2 = T2();
  const other = await colleague.signIn();
  await colleague.cal.addEvent({
    title: "Colleague busy",
    start: at(t1, "14:00"),
    end: at(t1, "15:00"),
  });
  const c = cal.calendarId;
  const me = (answer: "ACCEPTED" | "NEEDS-ACTION" | "DECLINED", email = EMAIL) => ({
    email,
    answer,
  });
  await putMeeting(c, {
    title: "Design review",
    start: at(t1, "10:00"),
    end: at(t1, "11:00"),
    organizer: EMAIL,
    attendees: [me("NEEDS-ACTION", COLLEAGUE_EMAIL)],
    location: "https://meet.jit.si/design-review",
  });
  await putMeeting(c, {
    title: "Vendor call",
    start: at(t1, "10:30"),
    end: at(t1, "11:30"),
    organizer: "organizer@example.com",
    attendees: [me("ACCEPTED")],
    description: ZOOM,
  });
  await putMeeting(c, {
    title: "Focus hold",
    start: at(t1, "10:00"),
    end: at(t1, "12:00"),
    organizer: "organizer@example.com",
    attendees: [me("ACCEPTED")],
    description: ZOOM,
    free: true,
  });
  await putMeeting(c, {
    title: "Declined lunch",
    start: at(t1, "10:15"),
    end: at(t1, "10:45"),
    organizer: "organizer@example.com",
    attendees: [me("DECLINED")],
    description: ZOOM,
  });
  await allDayBusy(c, "Team day", t1);
  await putMeeting(c, {
    title: "Budget sync",
    start: at(t1, "14:00"),
    end: at(t1, "14:30"),
    organizer: EMAIL,
    attendees: [me("ACCEPTED", COLLEAGUE_EMAIL)],
    location: "Room 4, Main Street 5, Berlin",
  });
  await putMeeting(c, {
    title: "Planning",
    start: at(t1, "16:00"),
    end: at(t1, "16:30"),
    organizer: EMAIL,
    attendees: [me("DECLINED", "dana@example.com")],
    location: "https://meet.google.com/abc-defg-hij",
  });
  const offsite = await putMeeting(c, {
    title: "Offsite prep",
    start: at(t2, "09:00"),
    end: at(t2, "09:30"),
    organizer: "organizer@example.com",
    attendees: [me("NEEDS-ACTION")],
    description: ZOOM,
  });
  const kickoffEvent = {
    title: "Kickoff",
    start: at(t2, "11:00"),
    end: at(t2, "11:30"),
    organizer: EMAIL,
    attendees: [me("ACCEPTED", "dana@example.com")],
  };
  const kickoff = await putMeeting(c, kickoffEvent);
  await signIn();

  await openIssues(page);
  await expect(issue(page, "conflict", "Design review")).toContainText("Vendor call", LONG);
  await expect(issue(page, "attendee_availability", "Budget sync")).toContainText(
    `${COLLEAGUE_EMAIL} is not free`,
    LONG,
  );
  await expect(issue(page, "attendee_availability", "Planning")).toContainText(
    "dana@example.com declined",
  );
  await expect(issue(page, "rsvp_reminder", "Offsite prep")).toBeVisible();
  await expect(issue(page, "video_link", "Kickoff")).toBeVisible();
  // Exactly these five: no issue for the free, declined, all-day, linked or
  // in-person events.
  await expect(page.locator('[data-testid="issue"]')).toHaveCount(5);
  await expect(page.locator('[data-testid="issue"]', { hasText: "Focus hold" })).toHaveCount(0);
  await expect(page.locator('[data-testid="issue"]', { hasText: "Declined lunch" })).toHaveCount(0);
  await expect(page.locator('[data-testid="issue"]', { hasText: "Team day" })).toHaveCount(0);

  // The guest sees no issue for a meeting someone else organizes there.
  await other.getByRole("link", { name: "Planner" }).click();
  await other.getByRole("tab", { name: /^Issues/ }).click();
  await expect(other.getByTestId("checks-issues")).toContainText("No open issues");

  // The user answers the invitation and adds a video link: both issues resolve.
  await invitation(
    c,
    {
      title: "Offsite prep",
      description: ZOOM,
      span: { start: at(t2, "09:00"), end: at(t2, "09:30") },
      organizer: "organizer@example.com",
      attendees: [{ email: EMAIL, answer: "ACCEPTED" }],
    },
    offsite,
  );
  await putMeeting(c, { ...kickoffEvent, conference: "https://meet.jit.si/kickoff" }, kickoff);
  await expect(issue(page, "rsvp_reminder", "Offsite prep")).toHaveCount(0, LONG);
  await expect(issue(page, "video_link", "Kickoff")).toHaveCount(0, LONG);
  await page.reload();
  await page.getByRole("tab", { name: /^Issues/ }).click();
  await expect(issue(page, "conflict", "Design review")).toBeVisible(LONG);
  await expect(page.locator('[data-testid="issue"]')).toHaveCount(3);

  // Checks never edit an event (rule 7).
  const events = await cal.events(at(t1, "00:00"), at(addDays(t2, 1), "00:00"));
  const when = (title: string) => {
    const e = events.find((x) => x.summary === title);
    return e && `${local(e.start)}-${local(e.end).slice(11)}`;
  };
  expect(when("Design review")).toBe(`${t1} 10:00-11:00`);
  expect(when("Vendor call")).toBe(`${t1} 10:30-11:30`);
  expect(when("Budget sync")).toBe(`${t1} 14:00-14:30`);
});

test("checks are on for a new user; ignore hides one event or the whole series; a disabled check closes its issues and raises no new ones (rules 1-3)", async ({
  page,
  cal,
  signIn,
}) => {
  const t1 = T1();
  const t2 = T2();
  const c = cal.calendarId;
  await signIn();
  await openChecks(page);
  const form = page.getByTestId("checks-form");
  for (const name of [
    "Overlapping commitments",
    "Attendee declined or not free",
    "Unanswered invitations",
    "Missing video link",
  ])
    await expect(form.getByLabel(name)).toBeChecked();
  await expect(form.getByLabel("Agenda drafts")).not.toBeChecked();

  await putMeeting(c, {
    title: "Weekly 1:1",
    start: at(t1, "15:00"),
    end: at(t1, "15:30"),
    organizer: EMAIL,
    attendees: [{ email: "ben@example.com", answer: "ACCEPTED" }],
    rrule: "FREQ=DAILY;COUNT=3",
  });
  await putMeeting(c, {
    title: "Kickoff",
    start: at(t1, "11:00"),
    end: at(t1, "11:30"),
    organizer: EMAIL,
    attendees: [{ email: "dana@example.com", answer: "ACCEPTED" }],
  });
  await putMeeting(c, {
    title: "Retro",
    start: at(t2, "11:00"),
    end: at(t2, "11:30"),
    organizer: EMAIL,
    attendees: [{ email: "dana@example.com", answer: "ACCEPTED" }],
  });
  await putMeeting(c, {
    title: "Offsite prep",
    start: at(t2, "09:00"),
    end: at(t2, "09:30"),
    organizer: "organizer@example.com",
    attendees: [{ email: EMAIL, answer: "NEEDS-ACTION" }],
    description: ZOOM,
  });

  await openIssues(page);
  await expect(issue(page, "video_link", "Weekly 1:1")).toHaveCount(3, LONG);
  await expect(issue(page, "video_link", "Kickoff")).toBeVisible();
  await expect(issue(page, "video_link", "Retro")).toBeVisible();
  await expect(issue(page, "rsvp_reminder", "Offsite prep")).toBeVisible();

  await issue(page, "video_link", "Kickoff")
    .getByRole("button", { name: "Ignore this event" })
    .click();
  await expect(issue(page, "video_link", "Kickoff")).toHaveCount(0);
  await expect(issue(page, "video_link", "Retro")).toBeVisible();
  await expect(issue(page, "video_link", "Weekly 1:1")).toHaveCount(3);
  await issue(page, "video_link", "Weekly 1:1")
    .first()
    .getByRole("button", { name: "Ignore the series" })
    .click();
  await expect(issue(page, "video_link", "Weekly 1:1")).toHaveCount(0);
  await expect(issue(page, "video_link", "Retro")).toBeVisible();

  // Turning a check off closes its open issues.
  await openChecks(page);
  await form.getByLabel("Unanswered invitations").uncheck();
  await form.getByRole("button", { name: "Save checks" }).click();
  await expect(form.getByTestId("checks-saved")).toHaveText("Saved");
  await openIssues(page);
  await expect(issue(page, "video_link", "Retro")).toBeVisible();
  await expect(issue(page, "rsvp_reminder", "Offsite prep")).toHaveCount(0);

  // A new unanswered invitation raises nothing; a new meeting without a link
  // in the same sync shows that the checks ran.
  await putMeeting(c, {
    title: "Late invite",
    start: at(t2, "13:00"),
    end: at(t2, "13:30"),
    organizer: "organizer@example.com",
    attendees: [{ email: EMAIL, answer: "NEEDS-ACTION" }],
    description: ZOOM,
  });
  await putMeeting(c, {
    title: "Standup",
    start: at(t2, "14:00"),
    end: at(t2, "14:15"),
    organizer: EMAIL,
    attendees: [{ email: "dana@example.com", answer: "ACCEPTED" }],
  });
  await expect(issue(page, "video_link", "Standup")).toBeVisible(LONG);
  await expect(page.locator('[data-testid="issue"]', { hasText: "Late invite" })).toHaveCount(0);

  await page.reload();
  await page.getByRole("tab", { name: /^Issues/ }).click();
  await expect(issue(page, "video_link", "Standup")).toBeVisible(LONG);
  await expect(issue(page, "video_link", "Retro")).toBeVisible();
  await expect(issue(page, "video_link", "Kickoff")).toHaveCount(0);
  await expect(issue(page, "video_link", "Weekly 1:1")).toHaveCount(0);
  await expect(page.locator('[data-testid="issue"][data-check="rsvp_reminder"]')).toHaveCount(0);
  await openChecks(page);
  await expect(form.getByLabel("Unanswered invitations")).not.toBeChecked();
  await expect(form.getByLabel("Missing video link")).toBeChecked();
});

test("library entry 'Flag meeting problems' turns on the checks and a daily email digest that lists open, not ignored, issues once a day (rule 6; library entry 9)", async ({
  page,
  cal,
  signIn,
  mail,
}) => {
  const t1 = T1();
  const c = cal.calendarId;
  await signIn();
  await putMeeting(c, {
    title: "Board sync",
    start: at(t1, "09:00"),
    end: at(t1, "09:30"),
    organizer: "organizer@example.com",
    attendees: [{ email: EMAIL, answer: "NEEDS-ACTION" }],
    description: ZOOM,
  });
  for (const [title, time] of [
    ["Kickoff", "11:00"],
    ["Retro", "13:00"],
  ] as const) {
    await putMeeting(c, {
      title,
      start: at(t1, time),
      end: at(t1, time) + 30 * 60_000,
      organizer: EMAIL,
      attendees: [{ email: "dana@example.com", answer: "ACCEPTED" }],
    });
  }
  await openIssues(page);
  await expect(issue(page, "video_link", "Retro")).toBeVisible(LONG);
  await issue(page, "video_link", "Retro")
    .getByRole("button", { name: "Ignore this event" })
    .click();
  await expect(issue(page, "video_link", "Retro")).toHaveCount(0);

  await page.getByRole("link", { name: "Library" }).click();
  await page.getByRole("tab", { name: "Meeting checks" }).click();
  const entry = page.locator('[data-entry="Flag meeting problems"]');
  await expect(entry.locator(".badge")).toHaveCount(0);
  await entry.getByRole("button", { name: "Use" }).click();
  const form = page.getByTestId("checks-form");
  for (const name of [
    "Overlapping commitments",
    "Attendee declined or not free",
    "Unanswered invitations",
    "Missing video link",
  ])
    await expect(form.getByLabel(name)).toBeChecked();
  await expect(form.getByLabel("Daily digest")).toHaveValue("email");
  const time = soon();
  await form.getByLabel("Digest time").fill(time);
  await form.getByRole("button", { name: "Save checks" }).click();
  await expect(form.getByTestId("checks-saved")).toHaveText("Saved");
  await page.getByRole("link", { name: "Library" }).click();
  await page.getByRole("tab", { name: "Meeting checks" }).click();
  await expect(entry.locator(".badge")).toHaveText("Added");

  const digest = await dailyMail(mail, EMAIL, /Meeting issues/);
  expect(digest.text).toContain("Board sync");
  expect(digest.text).toContain("Kickoff");
  expect(digest.text).not.toContain("Retro");

  // The next digest is tomorrow at the same time.
  const sentOn = today();
  await page.reload();
  await openChecks(page);
  await expect(form.getByLabel("Digest time")).toHaveValue(time);
  await expect(page.getByTestId("digest-status")).toContainText(
    `Next digest: ${addDays(sentOn, 1)} ${time}`,
  );
  expect(await mail.count(EMAIL)).toBe(1);
});

test("a company check from a team admin flags only the meeting's organizer, shows locked to members, and a member can ignore one issue (rules 8-12)", async ({
  page,
  cal,
  signIn,
  colleague,
  mail,
}) => {
  const t1 = T1();
  const member = await teamOfTwo(page, signIn, colleague, mail);
  await openChecks(page);
  const add = page.getByTestId("company-check-form");
  await add.getByLabel("Name").fill("Agenda for big meetings");
  await add.getByLabel("At least this many attendees").fill("5");
  await add.getByLabel("Description is empty").check();
  await add.getByRole("button", { name: "Add company check" }).click();
  await expect(page.locator('[data-company-check="Agenda for big meetings"]')).toBeVisible();

  const guests = ["dana@example.com", "ben@example.com", "eve@example.com", EMAIL];
  const allHands = {
    title: "All hands prep",
    start: at(t1, "10:00"),
    end: at(t1, "11:00"),
    organizer: COLLEAGUE_EMAIL,
    attendees: guests.map((email) => ({ email, answer: "NEEDS-ACTION" as const })),
    location: "https://meet.jit.si/all-hands",
  };
  await putMeeting(colleague.cal.calendarId, allHands);
  await putMeeting(colleague.cal.calendarId, {
    title: "Small sync",
    start: at(t1, "13:00"),
    end: at(t1, "13:30"),
    organizer: COLLEAGUE_EMAIL,
    attendees: [{ email: "dana@example.com", answer: "ACCEPTED" }],
    location: "https://meet.jit.si/small",
  });
  // The admin's own copy of the invitation, as the server delivers it.
  await putMeeting(cal.calendarId, allHands);

  await openIssues(member);
  const flag = issue(member, "company", "All hands prep");
  await expect(flag).toContainText("Agenda for big meetings", LONG);
  await expect(flag).toContainText("Company check");
  await expect(issue(member, "company", "Small sync")).toHaveCount(0);

  // The admin is only a guest: an answer is due, but no company issue.
  await openIssues(page);
  await expect(issue(page, "rsvp_reminder", "All hands prep")).toBeVisible(LONG);
  await expect(page.locator('[data-testid="issue"][data-check="company"]')).toHaveCount(0);

  // Members see the check locked and cannot change it.
  await openChecks(member);
  const locked = member.locator('[data-company-check="Agenda for big meetings"]');
  await expect(locked).toContainText("🔒");
  await expect(locked.getByRole("checkbox")).toBeDisabled();
  await expect(locked.getByRole("button")).toHaveCount(0);
  await expect(member.getByTestId("company-check-form")).toHaveCount(0);

  await openIssues(member);
  await flag.getByRole("button", { name: "Ignore this event" }).click();
  await expect(flag).toHaveCount(0);
  await member.reload();
  await member.getByRole("tab", { name: /^Issues/ }).click();
  await expect(member.getByTestId("checks-issues")).toContainText("No open issues", LONG);
  await openChecks(member);
  await expect(locked).toContainText("🔒");
});

test("library entry 'Agenda drafts' stages a draft that is written only when applied, and the recommendations list shows a skipped habit, an unmet focus goal and a day with too many meetings (library entry 4; platform rule 5)", async ({
  page,
  cal,
  signIn,
}) => {
  const t1 = T1();
  const wed = addDays(W, 2);
  const c = cal.calendarId;
  await blockUntil(cal, W);
  // The test week is fully blocked, so a Wednesday habit finds no other day and is skipped.
  for (let d = 0; d < 7; d++) await allDayBusy(c, "Away", addDays(W, d));
  const workshop = await putMeeting(c, {
    title: "Strategy workshop",
    start: at(t1, "09:00"),
    end: at(t1, "15:30"),
    organizer: EMAIL,
    attendees: [
      { email: "dana@example.com", answer: "ACCEPTED" },
      { email: "ben@example.com", answer: "ACCEPTED" },
    ],
    location: "https://meet.jit.si/strategy",
  });
  await signIn();
  await addHabit(page, {
    title: "Gym",
    days: ["Wed"],
    min: 60,
    max: 60,
    noRoom: "Remove that day",
  });
  await page.getByRole("link", { name: "Library" }).click();
  await page
    .locator('[data-entry="Deep work protection"]')
    .getByRole("button", { name: "Add" })
    .click();
  await page.getByRole("tab", { name: "Meeting checks" }).click();
  await page
    .locator('[data-entry="Agenda drafts for my meetings"]')
    .getByRole("button", { name: "Use" })
    .click();
  const form = page.getByTestId("checks-form");
  await expect(form.getByLabel("Agenda drafts")).toBeChecked();
  await form.getByRole("button", { name: "Save checks" }).click();
  await expect(form.getByTestId("checks-saved")).toHaveText("Saved");

  await openIssues(page);
  const noAgenda = issue(page, "agenda", "Strategy workshop");
  await noAgenda.getByRole("button", { name: "Draft agenda" }).click({ timeout: 60_000 });
  await expect(noAgenda.getByTestId("agenda-draft")).toContainText("Agenda: Strategy workshop");
  // Staged: nothing is written yet.
  expect(await rawEvent(c, workshop)).not.toContain("DESCRIPTION");
  await noAgenda.getByRole("button", { name: "Apply draft" }).click();
  await eventually(
    () => rawEvent(c, workshop),
    (text) => expect(text).toContain("DESCRIPTION:Agenda: Strategy workshop"),
  );
  await expect(noAgenda).toHaveCount(0, LONG);

  await page.getByRole("tab", { name: /^Recommendations/ }).click();
  const recs = page.getByTestId("recommendations");
  const gym = recs.locator('[data-kind="habit"]', { hasText: "Gym" }).filter({ hasText: wed });
  await expect(gym).toBeVisible(LONG);
  await expect(
    recs.locator('[data-kind="focus"]', { hasText: "Deep work protection" }).first(),
  ).toBeVisible();
  await expect(recs.locator('[data-kind="heavy_day"]')).toContainText(t1);
  await expect(recs.locator('[data-kind="heavy_day"]')).toContainText("6 h 30 min of meetings");

  await page.reload();
  await page.getByRole("tab", { name: /^Recommendations/ }).click();
  await expect(gym).toBeVisible(LONG);
  await expect(recs.locator('[data-kind="heavy_day"]')).toContainText(t1);
  await page.getByRole("tab", { name: /^Issues/ }).click();
  await expect(page.getByTestId("checks-issues")).toBeVisible();
  await expect(issue(page, "agenda", "Strategy workshop")).toHaveCount(0);
  expect(await rawEvent(c, workshop)).toContain("DESCRIPTION:Agenda: Strategy workshop");
});
