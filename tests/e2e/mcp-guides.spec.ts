// Setup guides per AI tool on the Account page (docs/specs/integrations-ai-tools.md
// rules 10-13, 15-20): ChatGPT, Claude, Claude Code and Cursor. Each guide shows
// this server's MCP URL with Copy, the steps of that client, the OAuth steps, the
// troubleshooting text and how to disconnect. The vendor apps are not part of
// this test; the test proves that what the guides give matches the server.
//
// Ways this can fail, each covered below:
// - a guide is missing, or shows the URL of another host or path;
// - Copy puts another text on the clipboard than the URL, command or JSON shown;
// - the Claude Code command or the Cursor mcp.json entry has the wrong form;
// - the URL in a guide does not lead an OAuth client to this server's sign-in;
// - the guides tell the user to click a button that the consent page does not have;
// - a client connected with the guide's URL does not show in "Connected AI tools".
import { addDays } from "../../src/shared/time.ts";
import { at, BASE_URL, expect, test } from "./fixtures.ts";
import { W } from "./helpers.ts";
import { oauthConnect } from "./mcp-oauth-helpers.ts";

const tue = addDays(W, 1);
const MCP_URL = `${BASE_URL}/mcp`;
const TROUBLE = [
  "Check that the URL is exactly",
  "Use the same email in",
  "Restart or refresh",
  "Remove the connection and add it again",
  "Authenticate again",
];

test("the Account page has a setup guide for ChatGPT, Claude, Claude Code and Cursor with this server's MCP URL, the sign-in steps and troubleshooting, and the URL connects (integrations-ai-tools rules 10-13, 15-20)", async ({
  page,
  cal,
  signIn,
  request,
}) => {
  await cal.addEvent({ title: "Design review", start: at(tue, "10:00"), end: at(tue, "11:00") });
  await signIn();
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.getByRole("link", { name: "Account", exact: true }).click();
  const guides = page.getByTestId("mcp-guides");
  const clipboard = () => page.evaluate(() => navigator.clipboard.readText());
  const open = async (client: string) => {
    await guides.getByRole("tab", { name: client, exact: true }).click();
    await expect(guides.getByRole("tab", { name: client, exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const panel = guides.getByRole("tabpanel");
    await expect(panel).toHaveAttribute("data-client", client);
    return panel;
  };
  const copy = async (panel: ReturnType<typeof page.getByRole>, testId: string) => {
    await page.evaluate(() => navigator.clipboard.writeText(""));
    const box = panel.getByTestId(testId);
    await box.getByRole("button", { name: "Copy" }).click();
    await expect.poll(clipboard).not.toBe("");
    return {
      shown: (await box.locator("code, pre").innerText()).trim(),
      copied: await clipboard(),
    };
  };

  // ChatGPT (rules 10, 11): a custom connector with this URL, OAuth, then Disconnect.
  const chatgpt = await open("ChatGPT");
  const url = await copy(chatgpt, "guide-url");
  expect(url).toEqual({ shown: MCP_URL, copied: MCP_URL });
  await expect(chatgpt).toContainText("custom connector");
  await expect(chatgpt).toContainText("ChatGPT plan");
  await expect(chatgpt).toContainText("Allow access");
  await expect(chatgpt).toContainText("connected apps");
  await expect(chatgpt).toContainText("Disconnect");

  // Claude Desktop and the Claude web app (rules 12, 15, 16).
  const claude = await open("Claude");
  expect(await copy(claude, "guide-url")).toEqual({ shown: MCP_URL, copied: MCP_URL });
  const steps = claude.getByTestId("guide-steps").locator("li");
  await expect(steps.nth(0)).toContainText("Settings");
  await expect(steps.nth(0)).toContainText("connectors");
  await expect(steps.nth(1)).toContainText("custom connector");
  await expect(steps.nth(1)).toContainText("Tempoloom");
  await expect(steps.nth(2)).toContainText("MCP URL");
  await expect(steps.nth(3)).toContainText("Allow access");
  await expect(steps.nth(4)).toContainText("tool permissions");
  for (const line of TROUBLE) await expect(claude.getByTestId("guide-trouble")).toContainText(line);
  await expect(claude.getByTestId("guide-trouble")).toContainText(`${MCP_URL}`);
  await expect(claude).toContainText("Disconnect or Remove");

  // Claude Code (rules 13, 15): the exact command with this URL; list and reinstall.
  const code = await open("Claude Code");
  expect(await copy(code, "guide-command")).toEqual({
    shown: `claude mcp add tempoloom -t http ${MCP_URL}`,
    copied: `claude mcp add tempoloom -t http ${MCP_URL}`,
  });
  await expect(code).toContainText("claude mcp list");
  await expect(code).toContainText("claude mcp remove tempoloom");
  await expect(code).toContainText("Allow access");
  for (const line of TROUBLE) await expect(code.getByTestId("guide-trouble")).toContainText(line);

  // Cursor (rules 17-20): the mcp.json entry with this URL, Connect, troubleshooting.
  const cursor = await open("Cursor");
  const json = await copy(cursor, "guide-json");
  expect(json.copied).toBe(json.shown);
  const entry = JSON.parse(json.copied) as {
    mcpServers: { tempoloom: { type: string; url: string } };
  };
  expect(entry).toEqual({ mcpServers: { tempoloom: { type: "http", url: MCP_URL } } });
  await expect(cursor).toContainText("Tools & MCP");
  await expect(cursor).toContainText("New MCP Server");
  await expect(cursor).toContainText("Connect");
  await expect(cursor).toContainText("Allow access");
  const cursorTrouble = cursor.getByTestId("guide-trouble");
  await expect(cursorTrouble).toContainText("JSON syntax");
  await expect(cursorTrouble).toContainText("Restart Cursor");
  await expect(cursorTrouble).toContainText("Authenticate again");
  await expect(cursor).toContainText("delete the tempoloom entry");

  // The guide's URL is this server's MCP endpoint: without a token it answers 401
  // and names its OAuth metadata, which leads to this server's consent page.
  const guideUrl = entry.mcpServers.tempoloom.url;
  const denied = await request.post(guideUrl, {
    data: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    headers: { accept: "application/json, text/event-stream" },
  });
  expect(denied.status()).toBe(401);
  const metaUrl = /resource_metadata="([^"]+)"/.exec(
    denied.headers()["www-authenticate"] ?? "",
  )?.[1];
  expect(metaUrl).toBe(`${BASE_URL}/.well-known/oauth-protected-resource/mcp`);
  const resource = await (await request.get(metaUrl ?? "")).json();
  expect(resource.resource).toBe(guideUrl);
  const server = await (
    await request.get(`${resource.authorization_servers[0]}/.well-known/oauth-authorization-server`)
  ).json();
  expect(server.authorization_endpoint).toBe(`${BASE_URL}/oauth/authorize`);
  expect(server.code_challenge_methods_supported).toEqual(["S256"]);

  // The steps' "Allow access" is the consent page's button: a client that follows
  // them connects and reads the calendar.
  const client = await oauthConnect(page, "Cursor");
  const read = await client.tool<{ events: { title: string }[] }>("list_events", {
    start: new Date(at(tue, "00:00")).toISOString(),
    end: new Date(at(addDays(tue, 1), "00:00")).toISOString(),
  });
  expect(read.events.map((e) => e.title)).toEqual(["Design review"]);

  // After a reload the guides still give the same URL, and the client shows as connected.
  await page.goto("/account");
  await page.reload();
  await expect(page.getByTestId("oauth-grants").locator('[data-grant="Cursor"]')).toBeVisible();
  const again = await open("Cursor");
  expect(
    JSON.parse((await again.getByTestId("guide-json").locator("pre").innerText()).trim()),
  ).toEqual(entry);
  await expect(page.getByTestId("mcp-guides")).toContainText("Connected AI tools");
});
