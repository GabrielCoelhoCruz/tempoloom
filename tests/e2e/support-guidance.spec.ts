// Guidance for users: the manual reset steps on the account page
// (docs/specs/planning-pause.md, manual reset steps, E-0110), booked invitees
// that Tempoloom does not accept for them, and the help page for invitations
// hidden by anti-spam rules (docs/specs/support-troubleshooting.md rules 13-16; AT-5).
//
// Ways this can fail, and the check that catches each:
// - a reset step is missing, out of order, or links nowhere     -> list items, link targets, reload
// - Tempoloom answers the invitation for the booker              -> PARTSTAT on the Radicale event
// - a later plan run accepts it                                  -> PARTSTAT after a plan run and reload
// - the anti-spam fix is missing or not reachable from the index -> help page text, reload

import { at, BACKEND, blockUntil, eventually, expect, planNow, test } from "./fixtures.ts";
import { addLink, allEvents, book, claimPage, visitor, W } from "./helpers.ts";
import { rawEvent } from "./meeting-helpers.ts";

const STEPS = [
  ["Turn off each calendar mirroring policy", "/settings"],
  ["Turn off each habit", "/habits"],
  ["Delete open tasks or mark them done", "/tasks"],
  ["Turn off task integrations", null],
  ["Turn off flexible meetings you own", "/meetings"],
  ["Turn off recovery and travel buffers", "/settings"],
  ["Turn off focus time", "/settings"],
] as const;

test("the account page lists the manual reset steps in order, each with a link to its page (planning-pause.md manual reset steps)", async ({
  page,
  signIn,
}) => {
  await signIn();
  await page.goto("/account");
  const reset = page.getByTestId("reset-steps");
  await expect(reset.getByRole("heading", { level: 2 })).toHaveText("Reset scheduling by hand");
  const items = reset.locator("ol > li");
  await expect(items).toHaveCount(STEPS.length);
  for (const [i, [text, href]] of STEPS.entries()) {
    await expect(items.nth(i)).toContainText(text);
    if (href) await expect(items.nth(i).getByRole("link")).toHaveAttribute("href", href);
    else await expect(items.nth(i)).toContainText("API keys");
  }
  await expect(items.nth(4)).toContainText("decline those you attend");
  await page.reload();
  await expect(page.getByTestId("reset-steps").locator("ol > li")).toHaveCount(STEPS.length);
  await page.getByTestId("reset-steps").locator("ol > li").nth(1).getByRole("link").click();
  await expect(page).toHaveURL(/\/habits$/);
});

test("a booked invitee is not accepted for them: the answer stays needs-action (support rule 14; AT-5)", async ({
  page,
  browser,
  cal,
  signIn,
}) => {
  test.skip(BACKEND === "google", "Reads the raw CalDAV attendee answer.");
  await blockUntil(cal, W);
  await signIn();
  await claimPage(page, "ada");
  await addLink(page, { title: "Intro call", durations: "30", level: 2 });
  const v = await visitor(browser);
  await v.goto("/book/ada/intro-call");
  await book(v, at(W, "09:00"), "Gil Guest", "gil@example.com");

  const answer = async () => {
    const ev = (await allEvents(cal)).find((e) => e.summary === "Intro call with Gil Guest");
    if (!ev) return "missing";
    const ics = await rawEvent(cal.calendarId, ev.id);
    const line = ics.split(/\r?\n/).find((l) => /^ATTENDEE[;:].*mailto:gil@example\.com$/i.test(l));
    if (!line) return "no attendee";
    return /PARTSTAT=([A-Z-]+)/i.exec(line)?.[1]?.toUpperCase() ?? "NEEDS-ACTION";
  };
  await eventually(answer, (a) => expect(a).toBe("NEEDS-ACTION"));
  // A later plan run and a reload do not accept it either.
  await planNow(page);
  await page.reload();
  await expect(page.getByTestId("booking-list")).toContainText("Gil Guest");
  expect(await answer()).toBe("NEEDS-ACTION");
});

test("the help explains invitations hidden by anti-spam rules, without a Google account (support rules 13, 15, 16)", async ({
  page,
  signIn,
}) => {
  await signIn();
  await page.getByRole("link", { name: "Help", exact: true }).click();
  const index = page.getByTestId("help-index");
  await index
    .locator("section", { hasText: "Booking links" })
    .getByRole("link", { name: "Guests do not see a booked meeting" })
    .click();
  const help = page.getByTestId("help-page");
  await expect(help.getByRole("heading", { level: 1 })).toHaveText(
    "Guests do not see a booked meeting",
  );
  await expect(help).toContainText("invitations from unknown senders");
  await expect(help).toContainText("land in spam");
  await expect(help).toContainText("does not answer the invitation for the guest");
  const fixes = help.locator("li");
  await expect(fixes).toHaveCount(3);
  await expect(fixes.nth(0)).toContainText("“from everyone”");
  await expect(fixes.nth(0)).toContainText("ask your guests to do the same");
  await expect(fixes.nth(1)).toContainText("mark the sender as known");
  await expect(fixes.nth(2)).toContainText("booking reminder email");
  await page.reload();
  await expect(page.getByTestId("help-page")).toContainText("“from everyone”");
});
