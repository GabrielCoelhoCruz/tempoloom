// Page loads that answer late or fail (found by the next-up and task calendar
// flakes). The routes below hold or fail one call, so each fault shows on
// every run, not only on a slow runner.
//
// Ways it can fail, and the check that catches each:
// - the tasks page draws the answer of a load that read the open list after
//   the user went to the Done view (an action started in the open view loads
//   again when it ends)                       -> the Done view keeps the done
//                                                task and its +30 min button
// - the settings page shows nothing until every call answers
//                                             -> scheduling and hours show
//                                                while the calendars call waits
// - the settings page shows no error when one call fails, and hides the parts
//   that loaded                               -> an alert, and the other parts
import type { Page, Request, Route } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { addTask } from "./helpers.ts";

const row = (page: Page, title: string) => page.locator(`[data-task-title="${title}"]`);

/** Holds each request of `url` until the returned function is called. */
async function hold(page: Page, url: string): Promise<() => void> {
  let release = () => {};
  const released = new Promise<void>((r) => {
    release = r;
  });
  await page.route(url, async (route: Route) => {
    await released;
    await route.continue();
  });
  return release;
}

/** Waits until the page drew what its last answers changed. */
const drawn = (page: Page) =>
  page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))),
  );

test("the Done view keeps the done list when an action started in the open view loads again", async ({
  page,
  signIn,
}) => {
  await signIn();
  const task = { minutes: 30, split: false, due: "" } as const;
  await addTask(page, { ...task, title: "LR-Finished" });
  await addTask(page, { ...task, title: "LR-Still-open" });

  // The plan run after Done waits, so the user is in the Done view before the
  // action loads its list again.
  const release = await hold(page, "**/api/planner/sync");
  const done = page.waitForResponse(
    (r) => r.request().method() === "POST" && /\/api\/tasks\/[^/]+\/done$/.test(r.url()),
  );
  await row(page, "LR-Finished").getByRole("button", { name: "Done" }).click();
  expect((await done).ok()).toBe(true);
  await page.getByTestId("task-filter").getByRole("button", { name: "Done" }).click();
  await expect(row(page, "LR-Finished").getByRole("button", { name: "+30 min" })).toBeVisible();
  await expect(row(page, "LR-Still-open")).toBeHidden();

  // The action loads the list again after its plan run: wait until every list
  // load sent after the plan run has its answer, then until the page drew it.
  let afterSync: number | undefined;
  const loads: Request[] = [];
  page.on("response", (r) => {
    if (r.request().method() === "POST" && new URL(r.url()).pathname === "/api/planner/sync")
      afterSync ??= loads.length;
  });
  page.on("request", (r) => {
    if (r.method() === "GET" && new URL(r.url()).pathname === "/api/tasks") loads.push(r);
  });
  release();
  await expect.poll(() => afterSync !== undefined && loads.length > afterSync).toBe(true);
  for (const r of loads.slice(afterSync)) await r.response();
  await drawn(page);
  await expect(row(page, "LR-Still-open")).toBeHidden();
  await expect(row(page, "LR-Finished").getByRole("button", { name: "+30 min" })).toBeVisible();
  await expect(
    page.getByTestId("task-filter").getByRole("button", { name: "Done" }),
  ).toHaveAttribute("aria-pressed", "true");
});

test("the settings page shows each part when its data comes in, before a slow call answers", async ({
  page,
  signIn,
}) => {
  await signIn();
  const release = await hold(page, "**/api/calendars");
  await page.getByRole("link", { name: "Settings" }).click();
  const settings = page.getByTestId("settings-page");
  await expect(settings.getByRole("combobox", { name: "Planning" })).toHaveValue("on");
  await expect(page.getByTestId("hours-work")).toBeVisible();
  await expect(page.getByTestId("task-defaults")).toBeVisible();
  // The buffers need the calendar names: they wait for the held call.
  const recovery = settings.getByRole("button", { name: "Add 15 min recovery after meetings" });
  await expect(recovery).toBeHidden();
  release();
  await expect(recovery).toBeVisible();
  await expect(page.getByTestId("settings-load-error")).toBeHidden();
});

test("the settings page shows an error when one call fails, and the parts that loaded", async ({
  page,
  signIn,
}) => {
  await signIn();
  await page.route("**/api/focus", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({ status: 500, json: { error: "internal" } })
      : route.continue(),
  );
  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page.getByTestId("settings-load-error")).toContainText("API error 500");
  const settings = page.getByTestId("settings-page");
  await expect(settings.getByRole("combobox", { name: "Planning" })).toHaveValue("on");
  await expect(page.getByTestId("hours-work")).toBeVisible();
  const focus = settings.getByRole("button", { name: "Protect 10 hours of focus time per week" });
  await expect(focus).toBeHidden();

  // The next load that works takes the error away and shows the focus part.
  await page.unroute("**/api/focus");
  const saved = page.waitForResponse(
    (r) => r.request().method() === "PATCH" && new URL(r.url()).pathname === "/api/settings",
  );
  await settings
    .getByRole("combobox", { name: "Break between tasks and habits" })
    .selectOption("5");
  expect((await saved).ok()).toBe(true);
  await expect(page.getByTestId("settings-message")).toHaveText("Saved");
  await expect(focus).toBeVisible();
  await expect(page.getByTestId("settings-load-error")).toBeHidden();
});
