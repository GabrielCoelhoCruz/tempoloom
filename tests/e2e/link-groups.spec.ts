// Link groups: their own booking pages, editing and deleting them, and moving
// links between pages. Spec: booking-links-sharing.md rules 1-7 and edge case 4.
//
// Ways this can fail:
//  1. A group page does not list its links, or lists links of other pages;
//     the main page still lists the group's links.                            (rules 1, 3)
//  2. A booker cannot book from a group page.                                  (rule 3)
//  3. A group takes a slug that a booking page uses.                           (edge case 4)
//  4. A slug change or a link move does not warn, or old URLs keep working;
//     new URLs do not work.                                                   (rules 4, 5)
//  5. A link removed from a group disappears instead of going back to the main page.
//  6. Delete: "move" loses the links, or "delete" keeps them or the group page.  (rule 6)
//  7. The group's copy URL action copies another URL.                         (rule 7)
//  8. Any of this is lost on reload.
import type { Page } from "@playwright/test";
import { at, BASE_URL, blockUntil, eventually, expect, test } from "./fixtures.ts";
import { addLink, allEvents, book, claimPage, visitor, W } from "./helpers.ts";
import { editLink, saveLink } from "./link-helpers.ts";

const section = (p: Page, slug: string) => p.locator(`[data-page="${slug}"]`);

async function newGroup(p: Page, title: string, links: string[]): Promise<void> {
  await p.getByRole("button", { name: "New group" }).click();
  const form = p.getByTestId("group-form");
  await form.getByLabel("Title").fill(title);
  for (const l of links) await form.getByLabel(l, { exact: true }).check();
  await form.getByRole("button", { name: "Create group" }).click();
  await expect(p.getByTestId("group-form")).toHaveCount(0);
}

async function publicLinks(v: Page, path: string): Promise<string[]> {
  await v.goto(path);
  await expect(v.getByTestId("public-page")).toBeVisible();
  return v.getByTestId("public-link").locator("span:first-child").allTextContents();
}

test("a link group gets its own booking page with its links, and a booker books from it (sharing rules 1-3, 7, edge case 4)", async ({
  page,
  browser,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await claimPage(page, "gwen");
  await addLink(page, { title: "Chat", durations: "30" });
  await addLink(page, { title: "Screen", durations: "45" });

  // A slug that a booking page uses is refused (edge case 4).
  await page.getByRole("button", { name: "New group" }).click();
  let form = page.getByTestId("group-form");
  await form.getByLabel("Title").fill("Gwen");
  await form.getByRole("button", { name: "Create group" }).click();
  await expect(form.getByRole("alert")).toContainText("taken");
  await form.getByRole("button", { name: "Cancel" }).click();

  await newGroup(page, "Interviews", ["Chat", "Screen"]);
  const group = section(page, "interviews");
  await expect(group).toContainText("Interviews");
  await expect(group.getByTestId("group-url")).toHaveText(`${BASE_URL}/book/interviews`);
  await expect(group.locator("[data-link-title]")).toHaveCount(2);
  await expect(section(page, "main").locator('[data-link-title="Chat"]')).toHaveCount(0);
  await group.getByRole("button", { name: "Copy group URL" }).click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(`${BASE_URL}/book/interviews`);
  const ed = await editLink(page, "Chat");
  await expect(ed.getByLabel("Page", { exact: true })).toHaveValue(/^(?!main$)(?!hidden$).+/);
  await expect(ed.getByLabel("Page", { exact: true }).locator("option:checked")).toHaveText(
    "Interviews",
  );
  await ed.getByRole("button", { name: "Cancel" }).click();

  const v = await visitor(browser);
  expect(await publicLinks(v, "/book/interviews")).toEqual(["Chat", "Screen"]);
  await expect(v.getByRole("heading", { level: 1 })).toHaveText("Interviews");
  expect(await publicLinks(v, "/book/gwen")).not.toContain("Chat");
  await v.goto("/book/gwen/chat");
  await expect(v.getByText("This booking link does not exist.")).toBeVisible();
  await v.goto("/book/interviews");
  await v.getByTestId("public-link").filter({ hasText: "Chat" }).click();
  await expect(v).toHaveURL(/\/book\/interviews\/chat$/);
  await book(v, at(W, "10:00"), "Ola", "ola@example.com");
  await eventually(
    () => allEvents(cal),
    (l) => expect(l.find((e) => e.summary === "Chat with Ola")).toBeDefined(),
  );

  await page.reload();
  await expect(section(page, "interviews").locator("[data-link-title]")).toHaveCount(2);
  expect(await publicLinks(v, "/book/interviews")).toEqual(["Chat", "Screen"]);
  form = page.getByTestId("group-form");
  await expect(form).toHaveCount(0);
});

test("editing a group warns before it breaks URLs; old URLs stop working; delete moves or removes the links (sharing rules 4-6)", async ({
  page,
  browser,
  signIn,
}) => {
  await signIn();
  await claimPage(page, "hugo");
  await addLink(page, { title: "Chat", durations: "30" });
  await addLink(page, { title: "Screen", durations: "45" });
  await newGroup(page, "Interviews", ["Chat", "Screen"]);
  await newGroup(page, "Sales", ["Meeting"]);
  const v = await visitor(browser);

  // Change the slug and the title, and remove a link: the form warns first.
  await section(page, "interviews").getByRole("button", { name: "Edit group" }).click();
  const ge = page.getByTestId("group-editor");
  await expect(ge.getByTestId("group-warning")).toHaveCount(0);
  await ge.getByLabel("Title").fill("Talks");
  await ge.getByLabel("URL name").fill("talks");
  await expect(ge.getByTestId("group-warning")).toBeVisible();
  await ge.getByLabel("Screen", { exact: true }).uncheck();
  await ge.getByRole("button", { name: "Save group" }).click();
  await expect(section(page, "talks")).toContainText("Talks");
  await expect(section(page, "interviews")).toHaveCount(0);
  await expect(section(page, "main").locator('[data-link-title="Screen"]')).toBeVisible();

  await v.goto("/book/interviews");
  await expect(v.getByText("This booking page does not exist.")).toBeVisible();
  await v.goto("/book/interviews/chat");
  await expect(v.getByText("This booking link does not exist.")).toBeVisible();
  expect(await publicLinks(v, "/book/talks")).toEqual(["Chat"]);
  await expect(v.getByRole("heading", { level: 1 })).toHaveText("Talks");
  await v.goto("/book/talks/chat");
  await expect(v.getByTestId("times")).toBeVisible();
  expect(await publicLinks(v, "/book/hugo")).toContain("Screen");

  // Moving a link to another page warns, and its old URL stops working.
  const ed = await editLink(page, "Screen");
  await expect(ed.getByTestId("page-warning")).toHaveCount(0);
  await ed.getByLabel("Page", { exact: true }).selectOption({ label: "Sales" });
  await expect(ed.getByTestId("page-warning")).toBeVisible();
  await saveLink(page);
  await expect(section(page, "sales").locator('[data-link-title="Screen"]')).toBeVisible();
  await v.goto("/book/hugo/screen");
  await expect(v.getByText("This booking link does not exist.")).toBeVisible();
  await v.goto("/book/sales/screen");
  await expect(v.getByTestId("times")).toBeVisible();

  // Delete "Sales", keeping its links on the main page.
  await section(page, "sales").getByRole("button", { name: "Delete group" }).click();
  let del = page.getByTestId("group-delete");
  await del.getByLabel("Move its links to").check();
  await del.getByLabel("Page for the links").selectOption({ label: "Main page" });
  await del.getByRole("button", { name: "Delete group" }).click();
  await expect(section(page, "sales")).toHaveCount(0);
  await expect(section(page, "main").locator('[data-link-title="Meeting"]')).toBeVisible();
  await expect(section(page, "main").locator('[data-link-title="Screen"]')).toBeVisible();
  await v.goto("/book/sales");
  await expect(v.getByText("This booking page does not exist.")).toBeVisible();
  expect(await publicLinks(v, "/book/hugo")).toEqual(expect.arrayContaining(["Meeting", "Screen"]));

  // Delete "Talks" together with its links.
  await section(page, "talks").getByRole("button", { name: "Delete group" }).click();
  del = page.getByTestId("group-delete");
  await del.getByLabel("Delete the group and its links").check();
  await del.getByRole("button", { name: "Delete group" }).click();
  await expect(section(page, "talks")).toHaveCount(0);
  await expect(page.locator('[data-link-title="Chat"]')).toHaveCount(0);
  await v.goto("/book/talks/chat");
  await expect(v.getByText("This booking link does not exist.")).toBeVisible();

  await page.reload();
  await expect(page.locator("[data-page]")).toHaveCount(2);
  await expect(section(page, "main").locator('[data-link-title="Screen"]')).toBeVisible();
  await expect(page.locator('[data-link-title="Chat"]')).toHaveCount(0);
});
