// Calendar mirroring policies: the list with account tabs, edits after
// creation, many-calendar setups, the destination rules, copy labels and
// colors, alerts, the full reconcile, guidance and the separate window
// (docs/specs/sync-calendar-mirroring.md rules 4, 6-8, 10, 12-17, 21, 26-30,
// 38-40, 43, 45-47, edge cases 11, 14, 16; planning-scheduling-window.md WIN-7).
//
// Ways it can fail, and the test that catches each:
// - the tabs miss an account, or filter by the wrong side of a policy      -> tabs
// - an edit is not saved, keeps old copies, or does not move them to a new
//   destination; the edit form does not show the saved values              -> tabs
// - details mode shows no warning about admins and calendar editors        -> tabs
// - delete happens without a confirmation, or leaves the copies behind     -> tabs
// - a calendar cannot be the source or destination of several policies,
//   copies chain from calendar to calendar, or a repeated pair is saved    -> mesh
// - a destination that is another account's main calendar is saved, or a
//   copy is written there; the other direction is refused too             -> main
// - labels ignore the category or the calendar type                        -> labels
// - an event that already invites the destination gets a copy             -> labels
// - the color override is not used, or stays after it is removed           -> labels
// - an alert added to a copy stays                                         -> alerts
// - a changed copy color is never put back; the last full check is unknown -> alerts
// - the guidance for family calendars and duplicate views is missing, or a
//   declined or tagged family event keeps its copy                          -> family
// - copies stop at the planning window, or go past 12 months               -> window
// - the help for busy-only Workspace sources, Gmail events and calendars that
//   arrive through Google or Microsoft is missing                          -> source help
// Every test reloads the page and reads the calendars again.
import { addDays } from "../../src/shared/time.ts";
import {
  addPolicy,
  copies,
  editRaw,
  openSettings,
  policyRow,
  rawEvent,
  week,
} from "./calendar-helpers.ts";
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
  planNow,
  test,
} from "./fixtures.ts";
import { addTask, W } from "./helpers.ts";
import { invitation, outOfOffice } from "./ics.ts";

const day = (n: number) => addDays(W, n);
const DAY = 86_400_000;

test.skip(BACKEND === "google", "Mirroring E2E uses CalDAV calendars and accounts.");

test("the policy list filters by account; an edit rewrites and moves the copies; details warn about admins; delete asks first (rules 6-8, 10, 26, 43)", async ({
  page,
  cal,
  signIn,
  people,
  radicale,
}) => {
  const six = radicale?.users[6];
  if (!radicale || !six) throw new Error("This test needs the CalDAV backend.");
  const extra = await people(6);
  await signIn();
  await addCalDavAccount(page, { ...six, email: extra.email });
  const priv = await cal.newCalendar("Private");
  const side = await extra.cal.newCalendar("Side");
  await priv.addEvent({
    title: "Dentist",
    start: at(W, "10:00"),
    end: at(W, "11:00"),
    description: "Bring the card",
  });
  await extra.cal.addEvent({ title: "Gym", start: at(day(1), "07:00"), end: at(day(1), "08:00") });
  const mine = `Work (${EMAIL})`;
  const theirs = `Work (${extra.email})`;
  await addPolicy(page, { from: "Private", to: mine });
  await addPolicy(page, { from: "Side", to: mine });
  await addPolicy(page, { from: theirs, to: "Side" });
  await eventually(
    () => week(cal),
    (l) => expect(copies(l).map((e) => e.summary)).toEqual(["🏠 Personal commitment"]),
  );
  await eventually(
    () => week(side),
    (l) => expect(copies(l)).toHaveLength(1),
  );

  // One tab per account; a tab shows policies where either side is that account's.
  const names = () =>
    page
      .getByTestId("mirror-list")
      .locator("[data-mirror]")
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-mirror")));
  const tabs = page.getByRole("tablist", { name: "Filter policies by account" });
  await expect(tabs.getByRole("tab")).toHaveText(["All", EMAIL, extra.email]);
  expect(await names()).toEqual([`Private → ${mine}`, `Side → ${mine}`, `${theirs} → Side`]);
  await tabs.getByRole("tab", { name: EMAIL, exact: true }).click();
  await expect(tabs.getByRole("tab", { name: EMAIL, exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(await names()).toEqual([`Private → ${mine}`, `Side → ${mine}`]);
  await tabs.getByRole("tab", { name: extra.email }).click();
  expect(await names()).toEqual([`Side → ${mine}`, `${theirs} → Side`]);
  await tabs.getByRole("tab", { name: "All" }).click();
  await expect(page.getByTestId("mirroring")).toContainText(
    "Each switch writes many events. Wait a few minutes between switches.",
  );

  // Edit: details mode warns; a new destination moves the copies there.
  await policyRow(page, `Private → ${mine}`).getByRole("button", { name: "Edit" }).click();
  const edit = page.getByTestId("mirror-edit");
  const warning = edit.getByTestId("mirror-warning");
  await expect(edit.getByLabel("Copy events from")).toHaveValue(/.+/);
  await expect(warning).toHaveCount(0);
  await edit.getByLabel("Copies show").selectOption({ label: "Details, private" });
  await expect(warning).toHaveText(
    "People who can change the destination calendar, and domain admins, can still see the details of these copies.",
  );
  await edit.getByLabel("Copies show").selectOption({ label: "A label only" });
  await expect(warning).toHaveCount(0);
  await edit.getByLabel("Copies show").selectOption({ label: "Details, private" });
  await edit.getByLabel("To").selectOption({ label: "Side" });
  await edit.getByRole("button", { name: "Save policy" }).click();
  await expect(policyRow(page, "Private → Side")).toContainText("details private");
  await eventually(
    () => week(cal),
    (l) => expect(copies(l)).toHaveLength(0),
  );
  const moved = await eventually(
    () => week(side),
    (l) => expect(copies(l).map((e) => e.summary)).toEqual(["Dentist", "🏠 Personal commitment"]),
  );
  expect(copies(moved)[0]?.description).toContain("Bring the card");
  await page.reload();
  await policyRow(page, "Private → Side").getByRole("button", { name: "Edit" }).click();
  await expect(edit.getByLabel("Copies show")).toHaveValue("details_private");
  await expect(edit.getByLabel("To").locator("option:checked")).toHaveText("Side");
  await expect(warning).toBeVisible();
  await edit.getByRole("button", { name: "Cancel" }).click();

  // Delete asks first, then removes the policy and its copies.
  await policyRow(page, `${theirs} → Side`).getByRole("button", { name: "Delete" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Delete this mirroring policy?");
  await expect(dialog).toContainText("This cannot be undone.");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByTestId("mirror-list").locator("[data-mirror]")).toHaveCount(3);
  await policyRow(page, `${theirs} → Side`).getByRole("button", { name: "Delete" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete policy" }).click();
  await expect(page.getByTestId("mirror-list").locator("[data-mirror]")).toHaveCount(2);
  await eventually(
    () => week(side),
    (l) => expect(copies(l).map((e) => e.summary)).toEqual(["Dentist"]),
  );
  await page.reload();
  await expect(page.getByTestId("mirror-list").locator("[data-mirror]")).toHaveCount(2);
});

test("three calendars that block each other take six policies; each event gets one copy on every other calendar and copies never chain; a repeated pair is refused (rules 12, 15; edge case 14)", async ({
  page,
  cal,
  signIn,
}) => {
  await signIn();
  const priv = await cal.newCalendar("Private");
  const side = await cal.newCalendar("Side");
  await cal.addEvent({ title: "Standup", start: at(W, "09:00"), end: at(W, "09:15") });
  await priv.addEvent({ title: "Climbing", start: at(day(1), "18:00"), end: at(day(1), "19:00") });
  await side.addEvent({ title: "Volunteer", start: at(day(2), "12:00"), end: at(day(2), "13:00") });
  const names = ["Work", "Private", "Side"];
  for (const from of names)
    for (const to of names) if (from !== to) await addPolicy(page, { from, to });
  const starts = async (c: typeof cal) =>
    copies(await week(c))
      .map((e) => local(e.start))
      .sort();
  await expect
    .poll(() => starts(cal), { timeout: 45_000 })
    .toEqual([`${day(1)} 18:00`, `${day(2)} 12:00`]);
  await expect
    .poll(() => starts(priv), { timeout: 45_000 })
    .toEqual([`${W} 09:00`, `${day(2)} 12:00`]);
  await expect
    .poll(() => starts(side), { timeout: 45_000 })
    .toEqual([`${W} 09:00`, `${day(1)} 18:00`]);

  await addPolicy(page, {
    from: "Private",
    to: "Work",
    error: "A mirroring policy from Private to Work already exists.",
  });
  await page.reload();
  await expect(page.getByTestId("mirror-list").locator("[data-mirror]")).toHaveCount(6);
  await planNow(page);
  expect(await starts(cal)).toEqual([`${day(1)} 18:00`, `${day(2)} 12:00`]);
});

test("a destination that is another Tempoloom account's main calendar is refused; that calendar can still be a source (rule 4; AT-10)", async ({
  page,
  cal,
  signIn,
  colleague,
  radicale,
}) => {
  if (!radicale) throw new Error("This test needs the CalDAV backend.");
  await colleague.signIn();
  await signIn();
  await cal.addEvent({ title: "Dentist", start: at(W, "10:00"), end: at(W, "11:00") });
  await colleague.cal.addEvent({ title: "Lunch", start: at(W, "12:00"), end: at(W, "13:00") });
  await addCalDavAccount(page, { ...radicale.colleague, email: COLLEAGUE_EMAIL });
  const mine = `Work (${EMAIL})`;
  const theirs = `Work (${COLLEAGUE_EMAIL})`;
  await addPolicy(page, {
    from: mine,
    to: theirs,
    error:
      "This calendar is the main calendar of another Tempoloom account. Choose another destination.",
  });
  await expect(page.getByTestId("mirror-list").locator("[data-mirror]")).toHaveCount(0);
  await addPolicy(page, { from: theirs, to: mine });
  await eventually(
    () => week(cal),
    (l) => expect(copies(l).map((e) => local(e.start))).toEqual([`${W} 12:00`]),
  );
  expect(copies(await week(colleague.cal))).toHaveLength(0);
  await page.reload();
  await expect(page.getByTestId("mirror-list").locator("[data-mirror]")).toHaveCount(1);
  await expect(policyRow(page, `${theirs} → ${mine}`)).toBeVisible();
});

test("labels follow the event category and the calendar type; an event that invites the destination gets no copy; a color override paints one policy's copies (rules 17, 27, 29)", async ({
  page,
  cal,
  signIn,
  people,
  radicale,
}) => {
  const six = radicale?.users[6];
  if (!radicale || !six) throw new Error("This test needs the CalDAV backend.");
  const extra = await people(6);
  await signIn();
  await addCalDavAccount(page, { ...six, email: extra.email });
  const priv = await cal.newCalendar("Private");
  await priv.addEvent({
    title: "Flight TP 1234 to Lisbon",
    start: at(W, "07:00"),
    end: at(W, "09:00"),
  });
  await priv.addEvent({
    title: "Drive to Porto",
    start: at(day(1), "07:00"),
    end: at(day(1), "08:00"),
  });
  await outOfOffice(priv.calendarId, "Away", {
    start: at(day(2), "08:00"),
    end: at(day(2), "18:00"),
  });
  await priv.addEvent({
    title: "Piano lesson",
    start: at(day(3), "18:00"),
    end: at(day(3), "19:00"),
  });
  await extra.cal.addEvent({
    title: "Design review",
    start: at(W, "13:00"),
    end: at(W, "14:00"),
    attendees: ["ann@tempoloom.test", "bob@tempoloom.test"],
  });
  await extra.cal.addEvent({
    title: "Write report",
    start: at(day(1), "13:00"),
    end: at(day(1), "14:00"),
  });
  // The destination's owner is invited: the event is on that calendar already.
  await extra.cal.addEvent({
    title: "All hands",
    start: at(day(2), "13:00"),
    end: at(day(2), "14:00"),
    attendees: [EMAIL],
  });
  const mine = `Work (${EMAIL})`;
  const theirs = `Work (${extra.email})`;
  await addPolicy(page, { from: "Private", to: mine, label: "Personal commitment" });
  await addPolicy(page, { from: theirs, to: mine, label: "Work commitment", color: "Tomato" });
  const seen = (l: Awaited<ReturnType<typeof week>>) =>
    copies(l).map((e) => [local(e.start), e.summary, e.colorId]);
  await eventually(
    () => week(cal),
    (l) =>
      expect(seen(l)).toEqual([
        [`${W} 07:00`, "Flight", "3"],
        [`${W} 13:00`, "Meeting", "11"],
        [`${day(1)} 07:00`, "Travel", "3"],
        [`${day(1)} 13:00`, "Work commitment", "11"],
        [`${day(2)} 08:00`, "PTO", "3"],
        [`${day(3)} 18:00`, "🏠 Personal commitment", "3"],
      ]),
  );

  // Without the override, the color rules decide again.
  await openSettings(page);
  await policyRow(page, `${theirs} → ${mine}`).getByRole("button", { name: "Edit" }).click();
  const edit = page.getByTestId("mirror-edit");
  await expect(edit.getByLabel("Color")).toHaveValue("11");
  await edit.getByLabel("Color").selectOption({ label: "Category colors" });
  await edit.getByRole("button", { name: "Save policy" }).click();
  await eventually(
    () => week(cal),
    (l) =>
      expect(seen(l).filter(([t]) => String(t).endsWith("13:00"))).toEqual([
        [`${W} 13:00`, "Meeting", "2"],
        [`${day(1)} 13:00`, "Work commitment", "2"],
      ]),
  );
  await page.reload();
  await policyRow(page, `${theirs} → ${mine}`).getByRole("button", { name: "Edit" }).click();
  await expect(page.getByTestId("mirror-edit").getByLabel("Color")).toHaveValue("");
});

test("copies never alert: an alert added to a copy is removed; the full reconcile puts back a changed color (rules 30, 38, 39)", async ({
  page,
  app,
  cal,
  signIn,
  radicale,
}) => {
  if (!radicale) throw new Error("This test needs the CalDAV backend.");
  app.env.MIRROR_RECONCILE_SECONDS = "10";
  await app.restart();
  await signIn();
  const priv = await cal.newCalendar("Private");
  await priv.addEvent({ title: "Dentist", start: at(W, "10:00"), end: at(W, "11:00") });
  await addPolicy(page, { from: "Private", to: "Work", color: "Banana" });
  const first = await eventually(
    () => week(cal),
    (l) => expect(copies(l)[0]?.colorId).toBe("5"),
  );
  const id = copies(first)[0]?.id ?? "";
  expect(await rawEvent(radicale, id)).not.toContain("BEGIN:VALARM");

  // Someone adds an alert to the copy: Tempoloom writes the copy again without it.
  await editRaw(radicale, id, (ics) =>
    ics.replace(
      "END:VEVENT",
      "BEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:Reminder\r\nTRIGGER:-PT10M\r\nEND:VALARM\r\nEND:VEVENT",
    ),
  );
  expect(await rawEvent(radicale, id)).toContain("BEGIN:VALARM");
  await expect
    .poll(() => rawEvent(radicale, id), { timeout: 45_000 })
    .not.toContain("BEGIN:VALARM");

  // Someone repaints the copy: the next full reconcile puts the policy color back.
  await editRaw(radicale, id, (ics) => ics.replace(/COLOR:[^\r\n]*/, "COLOR:red"));
  expect(await rawEvent(radicale, id)).toContain("COLOR:red");
  await eventually(
    () => week(cal),
    (l) => expect(copies(l).map((e) => e.colorId)).toEqual(["5"]),
  );
  await page.reload();
  const last = page.getByTestId("mirror-reconciled");
  await expect(last).toHaveText(/^Last full check: \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
});

test("guidance covers family calendars and duplicate views; a declined or tagged family event loses its copy for good (edge cases 11, 16; rule 40)", async ({
  page,
  cal,
  signIn,
  people,
  radicale,
}) => {
  const six = radicale?.users[6];
  if (!radicale || !six) throw new Error("This test needs the CalDAV backend.");
  // The family calendar lives in another added account, whose owner gets the invitations.
  const extra = await people(6);
  await signIn();
  await addCalDavAccount(page, { ...six, email: extra.email });
  const family = await extra.cal.newCalendar("Family");
  const soccer = await family.addEvent({
    title: "Soccer practice",
    start: at(W, "17:00"),
    end: at(W, "18:00"),
  });
  const play = {
    title: "School play",
    description: "Hall B",
    span: { start: at(day(1), "15:00"), end: at(day(1), "16:00") },
    organizer: "school@example.com",
  };
  const playId = await invitation(family.calendarId, {
    ...play,
    attendees: [{ email: extra.email, answer: "ACCEPTED" }],
  });
  await addPolicy(page, { from: "Family", to: `Work (${EMAIL})` });
  const tips = page.getByTestId("mirror-tips");
  await expect(tips).toContainText(
    "A copy goes away for good when you decline or delete the original event, or add #tl_nosync to it.",
  );
  await expect(tips).toContainText(
    "Family calendar: copies of family events land on your work calendar. Decline the events that do not concern you, or ask your family to add #tl_nosync to them.",
  );
  await expect(tips).toContainText(
    "Seeing each event twice? Your calendar app shows both the original and the copy. Hide the source calendar in your calendar app.",
  );
  await eventually(
    () => week(cal),
    (l) => expect(copies(l)).toHaveLength(2),
  );

  await family.update(soccer, {
    start: at(W, "17:00"),
    end: at(W, "18:00"),
    summary: "Soccer practice #tl_nosync",
  });
  await invitation(
    family.calendarId,
    { ...play, attendees: [{ email: extra.email, answer: "DECLINED" }] },
    playId,
  );
  await eventually(
    () => week(cal),
    (l) => expect(copies(l)).toHaveLength(0),
  );
  await page.reload();
  await expect(page.getByTestId("mirror-tips")).toContainText("Hide the source calendar");
  await planNow(page);
  await planNow(page);
  expect(copies(await week(cal))).toHaveLength(0);
});

test("mirroring keeps copies 12 months ahead while planning stops at its own window (WIN-7; rule 14)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await openSettings(page);
  const weeks = page.getByLabel("Plan ahead (weeks)");
  await weeks.fill("1");
  await weeks.press("Tab");
  await expect(page.getByTestId("settings-message")).toHaveText("Saved");
  const priv = await cal.newCalendar("Private");
  for (const n of [150, 350, 372])
    await priv.addEvent({
      title: `Trip ${n}`,
      start: at(day(n), "10:00"),
      end: at(day(n), "11:00"),
    });
  await addPolicy(page, { from: "Private", to: "Work" });
  // A task that may start only after the planning window gets no event.
  await addTask(page, {
    title: "AT-Later",
    minutes: 60,
    split: false,
    due: "",
    startAfter: `${day(20)}T09:00`,
  });
  const far = () => cal.events(Date.now() + 100 * DAY, Date.now() + 400 * DAY);
  await eventually(far, (l) =>
    expect(copies(l).map((e) => local(e.start))).toEqual([
      `${day(150)} 10:00`,
      `${day(350)} 10:00`,
    ]),
  );
  const near = await cal.events(Date.now(), Date.now() + 100 * DAY);
  expect(near.filter((e) => e.summary.includes("AT-Later"))).toHaveLength(0);
  await page.reload();
  await openSettings(page);
  await expect(page.getByLabel("Plan ahead (weeks)")).toHaveValue("1");
  await planNow(page);
  expect(copies(await far()).map((e) => local(e.start))).toEqual([
    `${day(150)} 10:00`,
    `${day(350)} 10:00`,
  ]);
});

test("the mirroring help names the fixes for missing source details (Workspace external sharing, the Gmail event visibility setting) and says that iCloud and other calendars arrive through Google or Microsoft, hours late, while a CalDAV server connects directly (rules 45-47)", async ({
  page,
  signIn,
}) => {
  await signIn();
  const texts = [
    // Rule 45.
    "Only busy blocks from a Google Workspace calendar? The domain's external sharing setting hides the details. Ask the domain admin to allow external sharing of full event details.",
    // Rule 46.
    'Events that Gmail added to the source calendar show their details only when that calendar\'s "Events from Gmail" visibility setting allows it.',
    // Rule 47.
    "iCloud and other calendars hosted elsewhere reach Tempoloom only after you add them to a Google or Microsoft account. Their changes can then arrive many hours late, and Tempoloom cannot make this faster.",
    "A CalDAV server, iCloud too, connects directly instead: add it on the Account page.",
  ];
  for (const reload of [false, true]) {
    if (reload) await page.reload();
    await openSettings(page);
    const help = page.getByTestId("mirror-source-help");
    for (const t of texts) await expect(help).toContainText(t);
  }
});
