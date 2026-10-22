// Settings > Integrations (docs/specs/integrations-overview.md rules 1, 2, 13;
// Outputs): one card per integration, grouped by category, "Not available yet"
// for tools Tempoloom does not build yet, the Google Calendar card ("Not
// configured on this server" without a Google client), the Outlook Calendar
// card, and the "Suggest a tool" link.
//
// Ways it can fail, and the check that catches each:
// - a tool of the table has no card, or a card sits in the wrong group -> card names per group
// - a tool that is not built offers Connect, or sends the operator to a
//   setting that does not exist                                        -> disabled Connect, Not available yet
// - the Google card ignores the server's Google client                 -> state after a restart with one
// - the Google card's Connect signs a CalDAV user in as another user   -> no Connect without a Google account
// - a connected account does not show on its card                      -> CalDAV account label is not on the Google card;
//                                                                         Google card state per configuration
// - "Suggest a tool" is missing or ignores the server's support address -> link target before and after
import type { Page } from "@playwright/test";
import { BACKEND, expect, test } from "./fixtures.ts";

const GROUPS: [string, string[]][] = [
  ["Calendar", ["Google Calendar", "Outlook Calendar"]],
  ["Communication", ["Slack", "Zoom", "Gong"]],
  ["Developer", ["Webhooks"]],
  ["Tasks", ["Google Tasks", "Todoist", "Asana", "ClickUp", "Jira", "Linear"]],
  ["Launcher", ["Raycast"]],
  ["Automation platform", ["Zapier"]],
  ["AI tools", ["AI tools"]],
  ["Add-on", ["Calendar add-on"]],
];
const NOT_BUILT = [
  "Outlook Calendar",
  "Slack",
  "Zoom",
  "Gong",
  "Google Tasks",
  "Todoist",
  "Asana",
  "ClickUp",
  "Jira",
  "Linear",
  "Calendar add-on",
];

const card = (page: Page, name: string) =>
  page.locator(`[data-testid="integration-card"][data-integration="${name}"]`);

async function openIntegrations(page: Page) {
  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByRole("link", { name: "Integrations" }).click();
  await expect(page.getByRole("heading", { name: "Integrations", level: 1 })).toBeVisible();
}

test("Settings > Integrations shows one card per integration by category; tools Tempoloom does not build yet show Not available yet with Connect disabled (rules 1, 13)", async ({
  page,
  signIn,
}) => {
  test.skip(BACKEND === "google", "The Google backend may configure a Google client.");
  await signIn();
  await openIntegrations(page);
  const groups = page.getByTestId("integration-group");
  await expect(groups.locator("h2")).toHaveText(GROUPS.map(([g]) => g));
  for (const [g, names] of GROUPS) {
    const group = page.locator(`[data-testid="integration-group"][data-category="${g}"]`);
    await expect(group.getByTestId("integration-card").locator("h3")).toHaveText(names);
  }
  for (const name of NOT_BUILT) {
    await expect(card(page, name).getByTestId("integration-state")).toHaveText("Not available yet");
    await expect(card(page, name).getByRole("button", { name: "Connect" })).toBeDisabled();
  }
  // Built parts link to their settings.
  await expect(card(page, "Webhooks").getByTestId("integration-state")).toHaveText("Available");
  await card(page, "AI tools").getByRole("link", { name: "Settings" }).click();
  await expect(page.getByTestId("account-page")).toBeVisible();
  await page.goBack();
  await expect(card(page, "Zapier").getByTestId("integration-state")).toHaveText("Available");
  // The page can be linked and survives a reload.
  await page.reload();
  await expect(page).toHaveURL(/\/settings\/integrations$/);
  await expect(page.getByTestId("integration-card")).toHaveCount(
    GROUPS.flatMap(([, n]) => n).length,
  );
});

test("the Google Calendar card follows the server's Google client and offers a CalDAV user no Connect that would sign in as another user; the Outlook Calendar card is not available yet; Suggest a tool opens the server's support address or the project's issue form (rules 2, 13; calendar cards)", async ({
  page,
  app,
  signIn,
}) => {
  test.skip(BACKEND === "google", "The Google backend may configure a Google client.");
  await signIn();
  await openIntegrations(page);
  const google = card(page, "Google Calendar");
  await expect(google.getByTestId("integration-state")).toHaveText("Not configured on this server");
  await expect(google.getByRole("button", { name: "Connect" })).toBeDisabled();
  await expect(card(page, "Outlook Calendar").getByTestId("integration-state")).toHaveText(
    "Not available yet",
  );
  const suggest = page.getByRole("link", { name: "Suggest a tool" });
  await expect(suggest).toHaveAttribute(
    "href",
    "https://github.com/GabrielCoelhoCruz/tempoloom/issues/new?title=Integration%20request%3A%20",
  );

  // With a Google client and a support address on the server.
  app.env.GOOGLE_CLIENT_ID = "e2e-client.apps.googleusercontent.com";
  app.env.GOOGLE_CLIENT_SECRET = "e2e-secret";
  app.env.SUPPORT_URL = "https://help.example.com/contact";
  await app.restart();
  await page.reload();
  await expect(google.getByTestId("integration-state")).toHaveText("Not connected");
  // Google sign-in would make another user; adding a Google account is not built.
  await expect(google.getByTestId("integration-account")).toHaveText(
    "Adding a Google account to this sign-in is not available yet.",
  );
  await expect(google.getByRole("link")).toHaveCount(0);
  await expect(google.getByRole("button")).toHaveCount(0);
  await expect(page.locator('a[href^="/auth/google"]')).toHaveCount(0);
  // The CalDAV account is not a Google account.
  await expect(google).not.toContainText("e2e@tempoloom.test");
  await expect(card(page, "Outlook Calendar").getByTestId("integration-state")).toHaveText(
    "Not available yet",
  );
  await expect(page.getByRole("link", { name: "Suggest a tool" })).toHaveAttribute(
    "href",
    "https://help.example.com/contact",
  );
});

test("when the server's sign-in methods do not load, Settings > Integrations shows the error and all cards, and the Google Calendar card claims no state; a reload that loads them shows the state", async ({
  page,
  signIn,
}) => {
  test.skip(BACKEND === "google", "The Google backend may configure a Google client.");
  await signIn();
  await page.route("**/auth/methods", (r) => r.fulfill({ status: 500, body: "{}" }));
  await openIntegrations(page);
  await expect(page.getByTestId("integrations-error")).toHaveText(
    "Could not check this server's Google client (API error 500). Reload the page to try again.",
  );
  await expect(page.getByTestId("integration-card")).toHaveCount(
    GROUPS.flatMap(([, n]) => n).length,
  );
  const google = card(page, "Google Calendar");
  await expect(google.getByTestId("integration-state")).toHaveText("Unknown");
  await expect(google.getByRole("button", { name: "Connect" })).toBeDisabled();
  await expect(card(page, "Slack").getByTestId("integration-state")).toHaveText(
    "Not available yet",
  );
  await page.unroute("**/auth/methods");
  const methods = page.waitForResponse((r) => new URL(r.url()).pathname === "/auth/methods");
  await page.reload();
  expect((await methods).ok()).toBe(true);
  await expect(google.getByTestId("integration-state")).toHaveText("Not configured on this server");
  await expect(page.getByTestId("integrations-error")).toHaveCount(0);
});
