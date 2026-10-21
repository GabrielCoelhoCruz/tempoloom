// The weekly report, part B (docs/specs/analytics-weekly-reports.md rules 8-12,
// edge case 6): the next week preview, the priorities, and the public share
// page of the top part with its share links.
//
// Ways this can fail, each covered below:
// - next week's events are missing or on the wrong day, or this week's show;
// - the busiest or the lightest day is wrong, or a day or event has no planner link;
// - a done task shows, the order is not by priority, or a habit with no plan next week shows;
// - an item link does not open that item;
// - the share page exists before a confirmed share (a mail scanner opens every
//   link), needs a login, is indexed, or shows event titles or a login name;
// - a social share link does not carry the page link;
// - the owner cannot stop sharing, or the page outlives the account.
import { addDays, localToUtc } from "../../src/shared/time.ts";
import { at, BACKEND, blockUntil, EMAIL, expect, test, ZONE } from "./fixtures.ts";
import { addHabit, addTask, visitor, W } from "./helpers.ts";

const day = (n: number) => addDays(W, n);
const iso = (date: string, hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  return new Date(localToUtc(ZONE, date, h * 60 + m)).toISOString();
};
const REPORT = /^Your week/;

/** The links of an HTML email, by their text. */
function links(html: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of html.matchAll(/<a href="([^"]+)"[^>]*>([^<]*)<\/a>/g)) {
    out.set((m[2] ?? "").replace(/&amp;/g, "&"), (m[1] ?? "").replace(/&amp;/g, "&"));
  }
  return out;
}

/** The lines of one section of the text email, up to the next empty line. */
function section(text: string, heading: string): string[] {
  const lines = text.split("\n");
  const from = lines.indexOf(heading);
  if (from < 0) return [];
  const rest = lines.slice(from + 1);
  const end = rest.indexOf("");
  return end < 0 ? rest : rest.slice(0, end);
}

const withoutUrl = (l: string) => l.replace(/: https?:\/\/\S+$/, "");

function sendReport(app: { cli(...a: string[]): string }) {
  expect(app.cli("weekly-reports", "--now", iso(day(4), "09:30"))).toContain("sent 1 report");
}

test("the weekly report previews next week's calendar by day with the busiest and the lightest day, and lists the top open tasks and next week's habits by priority; each links into the app (rules 8, 9)", async ({
  page,
  cal,
  app,
  mail,
  signIn,
}) => {
  await blockUntil(cal, W);
  const next = day(7);
  await cal.addEvent({ title: "Board meeting", start: at(next, "10:00"), end: at(next, "12:00") });
  await cal.addEvent({ title: "Dentist", start: at(day(9), "14:00"), end: at(day(9), "14:30") });
  await cal.addEvent({ title: "Retro", start: at(day(11), "15:00"), end: at(day(11), "16:00") });
  // This week's event is not in the preview.
  await cal.addEvent({ title: "Old sync", start: at(day(1), "10:00"), end: at(day(1), "11:00") });
  await signIn();
  await addTask(page, { title: "Tidy notes", minutes: 30, split: false, due: "", level: 4 });
  await addTask(page, { title: "Ship release", minutes: 30, split: false, due: "", level: 1 });
  await addTask(page, { title: "Write report", minutes: 30, split: false, due: "", level: 2 });
  await addTask(page, { title: "Old task", minutes: 30, split: false, due: "", level: 1 });
  const old = page.locator('[data-task-title="Old task"]');
  await old.getByRole("button", { name: "Done" }).click();
  await expect(old).toHaveCount(0);
  const personal = { min: 30, max: 30, hours: "Personal hours" } as const;
  await addHabit(page, {
    title: "Gym",
    ideal: "18:00",
    level: 3,
    days: ["Tue"],
    defense: "Always busy",
    ...personal,
  });
  // A fresh form for each habit.
  await page.reload();
  await addHabit(page, { title: "Reading", ideal: "19:00", level: 1, days: ["Wed"], ...personal });
  // Starts after next week: no plan next week, so not listed.
  await page.reload();
  await addHabit(page, {
    title: "Piano",
    ideal: "19:00",
    level: 1,
    days: ["Mon"],
    starting: day(14),
    ...personal,
  });
  // The habits are planned next week before the report goes out.
  await expect
    .poll(
      async () =>
        (await cal.events(at(next, "00:00"), at(day(14), "00:00"))).filter((e) =>
          /Gym|Reading/.test(e.summary),
        ).length,
      { timeout: 60_000 },
    )
    .toBe(2);

  sendReport(app);
  const report = await mail.message(EMAIL, REPORT);
  const preview = section(report.text, "Next week:");
  // Busy time: Monday 2 h; Tuesday the busy habit; Wednesday the dentist (the
  // habit there is free); Thursday nothing; Friday the retro.
  expect(preview.filter((l) => !l.startsWith("  ")).map(withoutUrl)).toEqual([
    `Monday ${next} (busiest), 2 h`,
    `Tuesday ${day(8)}, 30 min`,
    `Wednesday ${day(9)}, 30 min`,
    `Thursday ${day(10)} (lightest), 0 min`,
    `Friday ${day(11)}, 1 h`,
  ]);
  const events = preview.filter((l) => l.startsWith("  ")).map(withoutUrl);
  expect(events).toContain("  10:00-12:00 Board meeting");
  expect(events).toContain("  14:00-14:30 Dentist");
  expect(events.some((l) => /^ {2}18:00-18:30 .*Gym/.test(l))).toBe(true);
  expect(events.some((l) => /^ {2}19:00-19:30 .*Reading/.test(l))).toBe(true);
  expect(report.text).not.toContain("Old sync");
  // The facts stay the only "- " lines of the email (weekly-report.spec.ts reads them so).
  expect(
    report.text.split("\n").filter((l) => l.startsWith("- ") && /Board|Gym|Ship/.test(l)),
  ).toEqual([]);
  const priorities = section(report.text, "Priorities:");
  expect(priorities.map(withoutUrl)).toEqual([
    "Tasks:",
    "  P1 Ship release",
    "  P2 Write report",
    "  P4 Tidy notes",
    "Habits next week:",
    "  P1 Reading",
    "  P3 Gym",
  ]);

  // The links open the planner at that day and the item.
  const a = links(report.html);
  expect(a.get(`Monday ${next}`)).toMatch(new RegExp(`/\\?week=${next}$`));
  const eventLink = [...a.entries()].find(([t]) => t.includes("Board meeting"))?.[1] ?? "";
  expect(eventLink).toMatch(new RegExp(`/\\?week=${next}$`));
  await page.goto(eventLink);
  await expect(page.getByTestId("week-label")).toContainText(next);
  await expect(page.locator(".ev", { hasText: "Board meeting" })).toBeVisible();
  await page.goto(a.get("Ship release") ?? "");
  await expect(page.getByTestId("task-edit").getByLabel("Title")).toHaveValue("Ship release");
  await page.goto(a.get("Reading") ?? "");
  await expect(page.getByTestId("habit-editor").getByLabel("Title")).toHaveValue("Reading");
});

test("a share link asks first; the confirmed share makes a public noindex page of the report's top part: week, totals and facts, no login name and no event titles; X, LinkedIn and Facebook get the page link; the owner can stop sharing (rules 10-12, edge case 6)", async ({
  page,
  browser,
  cal,
  app,
  mail,
  signIn,
}) => {
  test.skip(BACKEND === "google", "Meetings with attendees need CalDAV here.");
  await blockUntil(cal, W);
  await cal.addEvent({
    title: "Planning",
    start: at(day(1), "10:00"),
    end: at(day(1), "11:30"),
    attendees: ["ana@tempoloom.test", "ben@tempoloom.test"],
  });
  await cal.addEvent({ title: "Write spec", start: at(day(2), "09:00"), end: at(day(2), "11:30") });
  await cal.addEvent({
    title: "Board meeting",
    start: at(day(7), "10:00"),
    end: at(day(7), "12:00"),
  });
  await signIn();
  sendReport(app);
  const report = await mail.message(EMAIL, REPORT);
  const a = links(report.html);
  const direct = a.get("Direct link") ?? "";
  expect(direct).toMatch(/\/r\/[A-Za-z0-9_-]{20,}\/share\?to=link$/);
  expect(report.text).toContain(`Direct link: ${direct}`);
  const pageUrl = direct.replace(/\/share\?to=link$/, "");

  // No public page before a share action; opening a share link (as a mail
  // scanner does) only asks.
  const v = await visitor(browser);
  const missing = await v.request.get(pageUrl);
  expect(missing.status()).toBe(404);
  expect(missing.headers()["x-robots-tag"]).toBe("noindex, nofollow");
  for (const name of ["Direct link", "X", "LinkedIn", "Facebook"]) {
    const res = await v.request.get(a.get(name) ?? "", { maxRedirects: 0 });
    expect(res.status()).toBe(200);
  }
  expect((await v.request.get(pageUrl)).status()).toBe(404);

  // The direct link, confirmed, opens the public page with no login.
  await v.goto(direct);
  await expect(v.getByTestId("share-confirm")).toContainText("Event titles are not on it");
  await v.getByRole("button", { name: "Share on a direct link" }).click();
  await expect(v).toHaveURL(pageUrl);
  const shown = v.getByTestId("shared-report");
  // The user's name is the CalDAV user name, a login, not a display name.
  const [user] = app.query<{ name: string }>("SELECT name FROM users WHERE email = ?", EMAIL);
  expect(user?.name).toBe("e2e");
  await expect(shown.getByRole("heading", { level: 1 })).toHaveText("A week in review");
  await expect(shown).not.toContainText("e2e");
  await expect(v.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex, nofollow");
  const res = await v.request.get(pageUrl);
  expect(res.headers()["x-robots-tag"]).toBe("noindex, nofollow");
  await expect(shown).toContainText(`${W} to ${day(4)}`);
  await expect(shown.getByTestId("shared-totals").locator("li")).toHaveText([
    "Meetings: 1 h 30 min",
    "Solo work: 2 h 30 min",
    "Personal time: 0 min",
  ]);
  await expect(shown.getByTestId("shared-facts").locator("li")).toContainText([
    "Busiest meeting day: Tuesday (1 h 30 min)",
  ]);
  for (const title of ["Planning", "Write spec", "Board meeting"])
    await expect(shown).not.toContainText(title);
  await v.reload();
  await expect(shown.getByTestId("shared-totals").locator("li")).toHaveCount(3);

  // Once shared, each social link opens that site's share dialog for the page link.
  const target = encodeURIComponent(pageUrl);
  const expected: Record<string, string> = {
    X: `https://twitter.com/intent/tweet?url=${target}`,
    LinkedIn: `https://www.linkedin.com/sharing/share-offsite/?url=${target}`,
    Facebook: `https://www.facebook.com/sharer/sharer.php?u=${target}`,
  };
  for (const [name, url] of Object.entries(expected)) {
    const res = await v.request.get(a.get(name) ?? "", { maxRedirects: 0 });
    expect(res.status()).toBe(302);
    expect(res.headers().location).toBe(url);
  }

  // The owner stops sharing in Settings: the page is gone, also after a reload.
  await page.goto("/settings");
  const week = page.getByTestId("shared-week");
  await expect(week).toHaveText(new RegExp(`${W} to ${day(4)}`));
  const stopped = page.waitForResponse(
    (r) => r.request().method() === "POST" && /\/stop$/.test(new URL(r.url()).pathname),
  );
  await week.getByRole("button", { name: "Stop sharing" }).click();
  expect((await stopped).ok()).toBe(true);
  await expect(week).toHaveCount(0);
  expect((await v.request.get(pageUrl)).status()).toBe(404);
  await page.reload();
  await expect(page.getByTestId("weekly-report")).toBeVisible();
  await expect(page.getByTestId("shared-week")).toHaveCount(0);

  // Shared again from a social link: its confirm form answers with that site's
  // dialog (sent here without following it to the site).
  const x = a.get("X") ?? "";
  await v.goto(x);
  const confirm = v.getByTestId("share-confirm");
  await expect(confirm.getByRole("button", { name: "Share on X" })).toBeVisible();
  expect((await v.request.get(pageUrl)).status()).toBe(404);
  const res2 = await v.request.post(x.replace(/\?.*$/, ""), {
    form: {
      to: await confirm.locator('input[name="to"]').inputValue(),
      csrf: await confirm.locator('input[name="csrf"]').inputValue(),
    },
    maxRedirects: 0,
  });
  expect(res2.status()).toBe(303);
  expect(res2.headers().location).toBe(expected.X);
  expect((await v.request.get(pageUrl)).status()).toBe(200);

  // Edge case 6: after the account is deleted the page is gone.
  await page.goto("/account");
  await page.getByRole("button", { name: "Delete my account" }).click();
  await page.getByLabel("Type your email to confirm").fill(EMAIL);
  await page.getByRole("button", { name: "Delete account permanently" }).click();
  await expect(page.getByTestId("caldav-form")).toBeVisible();
  expect((await v.request.get(pageUrl)).status()).toBe(404);
});
