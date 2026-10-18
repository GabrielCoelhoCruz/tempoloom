// Booking pages: the starter links of a new page, the team's booking pages
// directory, and branding at team, page and link level.
// Specs: booking-links.md rule 2, teams-executive-assistant-use.md rules 5-6,
// booking-links-booking-page.md rules 25-31, booking-links-sharing.md (pages).
//
// Ways this can fail:
//  1. A new page gets other starter links, or wrong priorities or durations.  (booking-links rule 2)
//  2. The directory misses a member's page or public link, lists a hidden
//     link, or its copied URL does not open the booking page.               (EA rule 5)
//  3. The resolution order is wrong: a link that follows its page shows the
//     team logo while the page says none, or a link setting does not win.     (rules 26-27)
//  4. A later team default changes pages that already exist.                  (rule 28)
//  5. A member can change the team branding, or cannot choose custom.         (rule 29)
//  6. Uploads that are not JPG or PNG, or too large, are stored.              (edge case 5)
//  7. The banner is not shown at 3:1; the logo is a link without a homepage
//     URL, or not a link with one.                                           (rules 30-31)
//  8. Settings are lost on reload, or a form shows a value other than the saved one.
import { EMAIL, expect, test } from "./fixtures.ts";
import { addLink, claimPage, visitor } from "./helpers.ts";
import { editLink, saveLink, teamOf } from "./link-helpers.ts";
import { openTeam } from "./team-helpers.ts";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const GIF = Buffer.from("R0lGODlhAQABAAAAACw=", "base64");

test("a new booking page gets three starter links with their priorities and durations (booking-links rule 2)", async ({
  page,
  browser,
  signIn,
}) => {
  await signIn();
  await claimPage(page, "ida");
  const rows = page.getByTestId("link-list").getByTestId("link-row");
  await expect(rows).toHaveCount(3);
  await expect(page.locator('[data-link-title="Important meeting"]')).toContainText(
    "P1 critical · 30 min",
  );
  await expect(page.locator('[data-link-title="Quick meeting"]')).toContainText(
    "P3 medium · 15, 30 min",
  );
  await expect(page.locator('[data-link-title="Meeting"]')).toContainText("P2 high · 30, 60 min");

  const v = await visitor(browser);
  await v.goto("/book/ida");
  await expect(v.getByTestId("public-link")).toHaveCount(3);
  await v.getByTestId("public-link").filter({ hasText: "Quick meeting" }).click();
  const durations = v.getByTestId("durations").getByRole("button");
  await expect(durations).toHaveText(["15 min", "30 min"]);
  await page.reload();
  await expect(rows).toHaveCount(3);
});

test("any member finds every team member's booking page and public links in the directory and copies one (EA rule 5)", async ({
  page,
  browser,
  signIn,
  colleague,
  mail,
}) => {
  const [pc] = await teamOf(page, signIn, [colleague], mail);
  if (!pc) throw new Error("no colleague page");
  await claimPage(page, "gil");
  await addLink(page, { title: "Secret", durations: "30", hidden: true });
  await claimPage(pc, "hal");

  await pc.getByRole("button", { name: "Team booking pages" }).click();
  const dir = pc.getByTestId("booking-directory");
  const ana = dir.locator(`[data-member="${EMAIL}"]`);
  await expect(ana).toContainText("/book/gil");
  for (const t of ["Important meeting", "Quick meeting", "Meeting"]) {
    await expect(ana.locator(`[data-directory-link="${t}"]`)).toBeVisible();
  }
  await expect(ana).not.toContainText("Secret");
  await expect(dir.locator(`[data-member="${colleague.email}"]`)).toContainText("/book/hal");

  await ana
    .locator('[data-directory-link="Quick meeting"]')
    .getByRole("button", { name: "Copy link" })
    .click();
  const copied = (await pc.getByTestId("directory-copied").textContent()) ?? "";
  expect(copied).toMatch(/\/book\/gil\/quick-meeting$/);
  const v = await visitor(browser);
  await v.goto(new URL(copied).pathname);
  await expect(v.getByTestId("booking-page")).toContainText("Quick meeting");

  await pc.reload();
  await pc.getByRole("button", { name: "Team booking pages" }).click();
  await expect(
    pc.getByTestId("booking-directory").locator(`[data-member="${EMAIL}"]`),
  ).toContainText("Quick meeting");
});

test("branding: the admin uploads a logo and banner and sets the team default; the page copies it, the link setting wins, and a member can choose custom (rules 25-31)", async ({
  page,
  browser,
  signIn,
  colleague,
  mail,
}) => {
  const [pc] = await teamOf(page, signIn, [colleague], mail);
  if (!pc) throw new Error("no colleague page");
  await openTeam(page);
  const br = page.getByTestId("team-branding");
  await br
    .getByLabel(/^Logo/)
    .setInputFiles({ name: "logo.gif", mimeType: "image/gif", buffer: GIF });
  await expect(br.getByTestId("branding-error")).toContainText("JPG or PNG");
  await br.getByLabel(/^Logo/).setInputFiles({
    name: "big.png",
    mimeType: "image/png",
    buffer: Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]),
  });
  await expect(br.getByTestId("branding-error")).toContainText("2 MB");
  await br
    .getByLabel(/^Logo/)
    .setInputFiles({ name: "logo.png", mimeType: "image/png", buffer: PNG });
  await expect(br.getByTestId("logo-preview")).toBeVisible();
  await br
    .getByLabel(/^Banner/)
    .setInputFiles({ name: "banner.png", mimeType: "image/png", buffer: PNG });
  await expect(br.getByTestId("banner-preview")).toBeVisible();
  await br
    .getByLabel("Default for new booking pages")
    .selectOption({ label: "Team logo and banner" });
  await br.getByLabel("Homepage URL").fill("https://example.com/home");
  await br.getByRole("button", { name: "Save branding" }).click();
  await expect(br.getByTestId("branding-saved")).toBeVisible();

  // A member has no branding controls, and the API refuses the change.
  await openTeam(pc);
  await expect(pc.getByTestId("team-branding")).toHaveCount(0);
  const refused = await pc.evaluate(() =>
    fetch("/api/team/branding", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "none", homepageUrl: "" }),
    }).then((r) => r.status),
  );
  expect(refused).toBe(403);

  // A new page copies the team default; the logo links to the homepage.
  await claimPage(page, "jay");
  await expect(page.getByLabel("Page branding")).toHaveValue("custom");
  const v = await visitor(browser);
  await v.goto("/book/jay/meeting");
  await expect(v.getByTestId("brand-logo")).toBeVisible();
  await expect(v.getByTestId("brand-home")).toHaveAttribute("href", "https://example.com/home");
  const box = await v.getByTestId("brand-banner").boundingBox();
  expect(Math.round((box?.width ?? 0) / (box?.height ?? 1))).toBe(3);

  // A later team default does not change the page; without a homepage the logo is no link.
  await openTeam(page);
  await page.reload();
  await expect(br.getByLabel("Default for new booking pages")).toHaveValue("custom");
  await br.getByLabel("Default for new booking pages").selectOption({ label: "No logo" });
  await br.getByLabel("Homepage URL").fill("");
  await br.getByRole("button", { name: "Save branding" }).click();
  await expect(br.getByTestId("branding-saved")).toBeVisible();
  await page.getByRole("link", { name: "Booking links" }).click();
  await expect(page.getByLabel("Page branding")).toHaveValue("custom");
  await v.reload();
  await expect(v.getByTestId("brand-logo")).toBeVisible();
  await expect(v.getByTestId("brand-home")).toHaveCount(0);

  // The page says none; the link follows its page.
  await page.getByLabel("Page branding").selectOption("none");
  await expect(page.getByTestId("page-branding-saved")).toBeVisible();
  await v.reload();
  await expect(v.getByTestId("booking-page")).toBeVisible();
  await expect(v.getByTestId("brand-logo")).toHaveCount(0);
  await expect(v.getByTestId("brand-default")).toHaveCount(0);

  // The link setting wins over the page.
  await editLink(page, "Meeting");
  await page.getByTestId("link-editor").getByLabel("Branding").selectOption("custom");
  await saveLink(page);
  await v.reload();
  await expect(v.getByTestId("brand-logo")).toBeVisible();
  await editLink(page, "Meeting");
  await expect(page.getByTestId("link-editor").getByLabel("Branding")).toHaveValue("custom");
  await page.getByTestId("link-editor").getByLabel("Branding").selectOption("default");
  await saveLink(page);
  await v.reload();
  await expect(v.getByTestId("brand-default")).toBeVisible();
  await expect(v.getByTestId("brand-logo")).toHaveCount(0);
  await page.reload();
  await expect(page.getByLabel("Page branding")).toHaveValue("none");

  // The member's new page copies today's team default (none); their link may use custom.
  await claimPage(pc, "kim");
  await expect(pc.getByLabel("Page branding")).toHaveValue("none");
  await editLink(pc, "Quick meeting");
  await pc.getByTestId("link-editor").getByLabel("Branding").selectOption("custom");
  await saveLink(pc);
  await v.goto("/book/kim/quick-meeting");
  await expect(v.getByTestId("brand-logo")).toBeVisible();
  await v.goto("/book/kim/meeting");
  await expect(v.getByTestId("booking-page")).toBeVisible();
  await expect(v.getByTestId("brand-logo")).toHaveCount(0);
});
