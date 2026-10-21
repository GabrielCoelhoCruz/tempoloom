// Profile page: fields from the calendar account are read-only, the user's
// own fields are saved when changed (docs/specs/settings-profile.md PRF-1,
// PRF-4, PRF-8, AT 1, AT 3).
//
// Ways it can fail, and the check that catches each:
// - no way to the profile from the user menu               -> menu item
// - the name or time zone can be edited here                -> no inputs for them
// - an edited field is not saved, or only until reload      -> reload
// - a field typed while the page reads the account again
//   loses the typed text and saves nothing, or text typed
//   back to the stored value hides later changes            -> live reread
// - the saved values do not survive a server restart        -> restart
// - choices for size and use case are free text             -> select options
// - without a picture nothing shows instead of initials     -> initials on profile and booking page
import type { Page } from "@playwright/test";
import { EMAIL, expect, test, ZONE } from "./fixtures.ts";
import { changeElsewhere, claimPage, visitor } from "./helpers.ts";

async function openProfile(page: Page) {
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Profile" }).click();
  await expect(page.getByTestId("profile-page")).toBeVisible();
}

test("the profile shows account fields read-only and saves job title, company, size and use case (PRF-1, PRF-4, PRF-8)", async ({
  page,
  app,
  signIn,
}) => {
  await signIn();
  await openProfile(page);
  const fixed = page.getByTestId("profile-fixed");
  await expect(fixed).toContainText(EMAIL);
  await expect(fixed).toContainText(ZONE);
  await expect(fixed).toContainText("Change these in your calendar account");
  await expect(fixed.locator("input, select, textarea")).toHaveCount(0);

  await page.getByLabel("Job title").fill("Tester");
  await page.getByLabel("Job title").blur();
  await expect(page.getByTestId("profile-message")).toHaveText("Saved");
  await page.getByLabel("Company", { exact: true }).fill("Acme");
  await page.getByLabel("Company", { exact: true }).blur();
  await page.getByLabel("Company size").selectOption("11-50");
  await page.getByLabel("Use case").selectOption({ label: "Work" });
  await expect(page.getByTestId("profile-message")).toHaveText("Saved");

  const check = async () => {
    await expect(page.getByLabel("Job title")).toHaveValue("Tester");
    await expect(page.getByLabel("Company", { exact: true })).toHaveValue("Acme");
    await expect(page.getByLabel("Company size")).toHaveValue("11-50");
    await expect(page.getByLabel("Use case")).toHaveValue("work");
  };
  await page.reload();
  await check();
  await app.restart();
  await page.goto("/");
  await openProfile(page);
  await check();
});

test("a job title typed while the page reads the account again is saved (PRF-4)", async ({
  page,
  signIn,
}) => {
  await signIn();
  await openProfile(page);
  const title = page.getByLabel("Job title");
  await title.fill("Tester");
  // The page draws again before the user leaves the field; the typed value stays.
  await changeElsewhere(page, 5);
  await expect(title).toHaveValue("Tester");
  const saved = page.waitForResponse(
    (r) => new URL(r.url()).pathname === "/api/settings" && r.request().method() === "PATCH",
  );
  await title.blur();
  expect((await saved).request().postDataJSON()).toEqual({ profile: { jobTitle: "Tester" } });
  await expect(page.getByTestId("profile-message")).toHaveText("Saved");
  await page.reload();
  await expect(page.getByLabel("Job title")).toHaveValue("Tester");

  // Text typed back to the stored value is no change: the field follows a
  // value that another client saves next.
  await title.fill("Testers");
  await title.fill("Tester");
  await title.blur();
  const other = await page.request.patch("/api/settings", {
    data: { profile: { jobTitle: "Lead" } },
  });
  expect(other.status()).toBe(200);
  await expect(title).toHaveValue("Lead");
});

test("without a picture from the calendar account the profile and booking pages show initials (edge case 1)", async ({
  page,
  browser,
  signIn,
}) => {
  await signIn();
  await openProfile(page);
  const fixed = page.getByTestId("profile-fixed");
  const name = (
    await fixed.locator(".row", { hasText: "Name" }).locator("strong").innerText()
  ).trim();
  const words = name.split(/[\s@._-]+/).filter(Boolean);
  const expected =
    `${words[0]?.[0] ?? ""}${words.length > 1 ? (words.at(-1)?.[0] ?? "") : ""}`.toUpperCase();
  expect(expected).not.toBe("");
  await expect(page.getByTestId("profile-picture-initials")).toHaveText(expected);
  await expect(page.getByTestId("profile-picture")).toHaveCount(0);

  await claimPage(page, "initials");
  const v = await visitor(browser);
  await v.goto("/book/initials");
  await expect(v.getByTestId("public-page")).toBeVisible();
  await expect(v.getByTestId("owner-picture-initials")).toHaveText(expected);
  await v.reload();
  await expect(v.getByTestId("owner-picture-initials")).toHaveText(expected);
});
