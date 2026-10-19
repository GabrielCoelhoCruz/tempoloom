// Calendar mirroring in the planner (docs/specs/sync-calendar-mirroring.md
// rules 11, 33, 34; events-external-priority.md rule 4).
//
// Ways it can fail, and the test that catches each:
// - onboarding offers no first policy, or the offer saves no policy and
//   writes no copy, or it comes back after a reload                        -> onboarding
// - the planner shows the copy as a second item, or the item does not
//   name its source calendar and where it is copied to                     -> one item
// - an event on another connected calendar offers a priority change, or
//   gives no note that it stays P1; a main-calendar event loses the control;
//   a mirrored main-calendar event offers a change though its copy stays P1;
//   the API accepts a level for a mirrored event or a copy                  -> P1
// - "Not now" does not keep the offer hidden after a reload               -> Not now
// Every test reloads the page and reads the calendar again.
import { addPolicy, copies, openSettings, policyRow, week } from "./calendar-helpers.ts";
import { at, BACKEND, blockUntil, eventually, expect, test } from "./fixtures.ts";
import { openWeek, W } from "./helpers.ts";

test.skip(BACKEND === "google", "Mirroring E2E uses two CalDAV calendars.");

test("onboarding offers a first mirroring policy with one source and one destination (rule 11)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  // Created after sign-in, so the main calendar stays the primary one.
  await signIn();
  const priv = await cal.newCalendar("Private");
  await priv.addEvent({ title: "Dentist", start: at(W, "10:00"), end: at(W, "11:00") });
  await openWeek(page);
  await expect(page.getByTestId("planner-hints")).toHaveAttribute("data-loaded", "true");
  // One calendar: nothing to mirror yet.
  await expect(page.getByTestId("hint-first-mirror")).toHaveCount(0);
  await openSettings(page);
  await page.getByRole("button", { name: "Refresh calendar list" }).click();
  await expect(page.getByTestId("calendar-list")).toContainText("Private");
  await openWeek(page);
  const offer = page.getByTestId("hint-first-mirror");
  await expect(offer).toBeVisible();
  await offer.getByLabel("Copy events from").selectOption({ label: "Private" });
  await offer.getByLabel("To").selectOption({ label: "Work" });
  await offer.getByRole("button", { name: "Start mirroring" }).click();
  await expect(offer).toHaveCount(0);
  const l = await eventually(
    () => week(cal),
    (evs) => expect(copies(evs)).toHaveLength(1),
  );
  expect(copies(l)[0]?.summary).toContain("Personal commitment");
  await page.reload();
  await expect(page.getByTestId("planner-hints")).toHaveAttribute("data-loaded", "true");
  await expect(page.getByTestId("hint-first-mirror")).toHaveCount(0);
  await openSettings(page);
  await expect(policyRow(page, "Private → Work")).toBeVisible();
});

test("the planner shows a source event and its copy as one item with the source details (rule 33)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  const priv = await cal.newCalendar("Private");
  await priv.addEvent({
    title: "Dentist",
    start: at(W, "10:00"),
    end: at(W, "11:00"),
    description: "Bring the insurance card",
  });
  await addPolicy(page, { from: "Private", to: "Work" });
  await eventually(
    () => week(cal),
    (evs) => expect(copies(evs)).toHaveLength(1),
  );
  for (const pass of ["first", "after reload"]) {
    if (pass === "first") await openWeek(page);
    else await page.reload();
    await expect(page.locator(".ev", { hasText: "Dentist" })).toHaveCount(1);
    await expect(page.locator(".ev", { hasText: "Personal commitment" })).toHaveCount(0);
    await page.locator(".ev", { hasText: "Dentist" }).click();
    const drawer = page.getByTestId("event-drawer");
    await expect(drawer.getByTestId("event-source")).toHaveText("Calendar: Private");
    await expect(drawer.getByTestId("event-copies")).toHaveText("Copied to: Work");
    await expect(drawer).toContainText("Bring the insurance card");
  }
});

test("copies and events on other connected calendars stay P1 (rule 34)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await cal.addEvent({ title: "Standup", start: at(W, "09:00"), end: at(W, "09:30") });
  // The tag keeps this main-calendar event out of the mirroring: it keeps the control.
  await cal.addEvent({
    title: "Review",
    start: at(W, "13:00"),
    end: at(W, "13:30"),
    description: "#tl_nosync",
  });
  await signIn();
  const priv = await cal.newCalendar("Private");
  await priv.addEvent({ title: "Gym", start: at(W, "07:00"), end: at(W, "08:00") });
  await addPolicy(page, { from: "Work", to: "Private" });
  const copy = copies(
    await eventually(
      () => week(priv),
      (evs) => expect(copies(evs)).toHaveLength(1),
    ),
  )[0];
  expect(copy?.summary).not.toContain("Review");
  await openWeek(page);
  // The API refuses a level for the mirrored source, and treats the copy as no external event.
  await expect
    .poll(() =>
      page.evaluate(
        async ({ from, to, copyId }) => {
          const r = await fetch(`/api/planner/events?from=${from}&to=${to}`);
          const { events } = (await r.json()) as { events: { id: string; title: string }[] };
          // The id is ext:<calendar id>:<event id>; the event id may hold colons.
          const ref = (title: string) => {
            const [, calendarId, ...rest] = (events.find((e) => e.title === title)?.id ?? "").split(
              ":",
            );
            return [calendarId, rest.join(":")];
          };
          const [mainId, standupId] = ref("Standup");
          const [privId] = ref("Gym");
          const post = async (calendarId = "", eventId = "") => {
            const res = await fetch(
              `/api/planner/external/${encodeURIComponent(calendarId)}/${encodeURIComponent(eventId)}/priority`,
              {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ level: 4 }),
              },
            );
            return `${res.status} ${((await res.json()) as { reason?: string }).reason ?? ""}`.trim();
          };
          return [await post(mainId, standupId), await post(privId, copyId)];
        },
        { from: at(W, "00:00"), to: at(W, "23:59"), copyId: copy?.id ?? "" },
      ),
    )
    .toEqual(["400 mirrored", "404"]);
  for (const pass of ["first", "after reload"]) {
    if (pass === "first") await openWeek(page);
    else await page.reload();
    // A main-calendar event that is mirrored: its copy keeps the time at P1.
    await page.locator(".ev-external", { hasText: "Standup" }).click();
    let fixed = page.getByTestId("external-priority-fixed");
    await expect(fixed.getByLabel("Priority for booking links")).toBeDisabled();
    await expect(fixed.getByLabel("Priority for booking links")).toHaveValue("1");
    await expect(page.getByRole("button", { name: "Save priority" })).toHaveCount(0);
    await expect(fixed).toContainText(
      "Mirrored events stay P1: their copies on other calendars count as P1.",
    );
    await page.getByRole("button", { name: "Close" }).click();
    // An event on another connected calendar.
    await page.locator(".ev-external", { hasText: "Gym" }).click();
    fixed = page.getByTestId("external-priority-fixed");
    await expect(fixed.getByLabel("Priority for booking links")).toBeDisabled();
    await expect(fixed).toContainText(
      "Events from other calendars stay P1: only events on your main calendar can change.",
    );
    await page.getByRole("button", { name: "Close" }).click();
    // A main-calendar event that is not mirrored keeps the control.
    await page.locator(".ev-external", { hasText: "Review" }).click();
    await expect(
      page.getByTestId("external-priority").getByLabel("Priority for booking links"),
    ).toBeEnabled();
    await page.getByRole("button", { name: "Close" }).click();
  }
});

test("Not now hides the first mirroring offer for good (rule 11)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await cal.newCalendar("Private");
  await openSettings(page);
  await page.getByRole("button", { name: "Refresh calendar list" }).click();
  await expect(page.getByTestId("calendar-list")).toContainText("Private");
  await openWeek(page);
  const offer = page.getByTestId("hint-first-mirror");
  await expect(offer).toBeVisible();
  const dismissed = page.waitForResponse(
    (r) => r.url().endsWith("/api/hints/first-mirror/dismiss") && r.ok(),
  );
  await offer.getByRole("button", { name: "Not now" }).click();
  await dismissed;
  await expect(offer).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("planner-hints")).toHaveAttribute("data-loaded", "true");
  await expect(offer).toHaveCount(0);
  // Still no policy and two calendars: only the dismissal hides the offer.
  expect(
    await page.evaluate(async () => {
      const get = async (path: string) => (await fetch(path)).json();
      const { mirrors } = (await get("/api/mirrors")) as { mirrors: unknown[] };
      const { calendars } = (await get("/api/calendars")) as { calendars: { provider: string }[] };
      return [mirrors.length, calendars.filter((c) => c.provider !== "ics").length];
    }),
  ).toEqual([0, 2]);
});
