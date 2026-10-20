// Settings > Integrations (docs/specs/integrations-overview.md rules 1, 2, 13;
// Outputs): one card per integration, grouped by category, the "Not configured
// on this server" state for OAuth tools this server has no client for, the
// Google Calendar and Outlook Calendar cards, and the "Suggest a tool" link.
//
// Ways it can fail, and the check that catches each:
// - a tool of the table has no card, or a card sits in the wrong group -> card names per group
// - an unconfigured OAuth card offers Connect                          -> disabled Connect, state text
// - the Google card ignores the server's Google client                 -> Connect link after a restart with one
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

test("Settings > Integrations shows one card per integration by category; tools without a client on this server show Not configured on this server with Connect disabled (rules 1, 13)", async ({
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
    await expect(card(page, name).getByTestId("integration-state")).toHaveText(
      "Not configured on this server",
    );
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

test("the Google Calendar card follows the server's Google client and the Outlook Calendar card is not configured; Suggest a tool opens the server's support address or the project's issue form (rules 2, 13; calendar cards)", async ({
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
    "Not configured on this server",
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
  await expect(google.getByRole("link", { name: "Connect" })).toHaveAttribute(
    "href",
    "/auth/google/start",
  );
  // The CalDAV account is not a Google account.
  await expect(google).not.toContainText("e2e@tempoloom.test");
  await expect(card(page, "Outlook Calendar").getByTestId("integration-state")).toHaveText(
    "Not configured on this server",
  );
  await expect(page.getByRole("link", { name: "Suggest a tool" })).toHaveAttribute(
    "href",
    "https://help.example.com/contact",
  );
});
