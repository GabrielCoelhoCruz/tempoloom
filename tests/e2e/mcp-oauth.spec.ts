// AI tools connect to the one MCP server with OAuth 2.1 (docs/specs/integrations-ai-tools.md):
// a standard MCP client (the official MCP TypeScript SDK) registers itself, the
// user allows access on Tempoloom's consent page, and the client gets tokens
// with PKCE. ChatGPT, Claude and Cursor use the same flow; their own apps are
// not part of this test.
//
// Ways this can fail, each covered below:
// - the server gives no OAuth metadata, so a client cannot find where to sign in;
// - a client gets a token without the user's "Allow access", or after Cancel;
// - the consent page does not name the client or the Tempoloom account;
// - clients see different data, or reads wait for the user;
// - a write from an OAuth client reaches the calendar before the user applies it;
// - RSVP, focus time or a work session is written at once, not staged, or not at all;
// - revoking one client stops another, disconnects the calendar, or removes its events;
// - a revoked client still reads with its access token, or gets new tokens by refresh;
// - a staged change of a revoked client is lost.
import { addDays, utcToLocal } from "../../src/shared/time.ts";
import { createKey } from "./delegation-helpers.ts";
import {
  at,
  BASE_URL,
  blockUntil,
  type CalendarDriver,
  EMAIL,
  eventually,
  expect,
  local,
  managed,
  planNow,
  test,
  ZONE,
} from "./fixtures.ts";
import { addTask, MIN, W } from "./helpers.ts";
import {
  answerConsent,
  finishOAuth,
  oauthConnect,
  refreshWith,
  startOAuth,
  statusWith,
} from "./mcp-oauth-helpers.ts";
import { connect, iso, previewPanel, reviewAndApply, stagedRow } from "./preview-helpers.ts";

const tue = addDays(W, 1);
const wed = addDays(W, 2);
const thu = addDays(W, 3);
const weekEvents = (cal: CalendarDriver) => cal.events(at(W, "00:00"), at(addDays(W, 7), "00:00"));
const named = <T extends { summary: string }>(evs: T[], title: string) =>
  evs.filter((e) => e.summary === title);
const day = (d: string) => ({ start: iso(at(d, "00:00")), end: iso(at(addDays(d, 1), "00:00")) });

interface Listed {
  events: { id: string; title: string; start: string; organizer_self: boolean }[];
}

test("an MCP client signs in with OAuth on the consent page, reads at once, and its writes wait in preview mode until the user applies them (integrations-ai-tools rules 1-3, 21)", async ({
  page,
  cal,
  signIn,
  request,
}) => {
  await cal.addEvent({ title: "Design review", start: at(tue, "10:00"), end: at(tue, "11:00") });
  await signIn();
  await page.getByRole("link", { name: "Account", exact: true }).click();
  await expect(page.getByTestId("mcp-section")).toContainText(`${BASE_URL}/mcp`);
  await expect(page.getByTestId("oauth-grants")).toContainText("No AI tool is connected");

  // Discovery: the 401 names the resource metadata, which names the authorization server.
  const denied = await request.post("/mcp", {
    data: { jsonrpc: "2.0", id: 1, method: "tools/list" },
  });
  expect(denied.status()).toBe(401);
  expect(denied.headers()["www-authenticate"]).toContain(
    `resource_metadata="${BASE_URL}/.well-known/oauth-protected-resource/mcp"`,
  );
  const meta = await (await request.get("/.well-known/oauth-protected-resource/mcp")).json();
  expect(meta).toMatchObject({ resource: `${BASE_URL}/mcp`, authorization_servers: [BASE_URL] });

  // Cancel on the consent page gives the client an error and no code.
  const cancelled = await startOAuth("Cursor");
  const no = await answerConsent(page, cancelled, "Cancel");
  expect(no.get("error")).toBe("access_denied");
  expect(no.get("code")).toBeNull();
  expect(no.get("state")).toBe(cancelled.nonce);

  // Allow access: the page names the client and the Tempoloom account it connects.
  const provider = await startOAuth("Claude");
  await page.goto(provider.authUrl?.toString() ?? "");
  const consent = page.getByTestId("oauth-consent");
  await expect(consent).toContainText("Claude");
  await expect(consent).toContainText(EMAIL);
  const yes = await answerConsent(page, provider, "Allow access");
  const claude = await finishOAuth(provider, yes.get("code") ?? "");
  // A code works once.
  await expect(finishOAuth(provider, yes.get("code") ?? "")).rejects.toThrow();

  // Rule 2: a read answers at once and changes nothing.
  const listed = await eventually(
    () => claude.tool<Listed>("list_events", day(tue)),
    (r) => expect(r.events.map((e) => e.title)).toEqual(["Design review"]),
  );
  expect(Date.parse(listed.events[0]?.start ?? "")).toBe(at(tue, "10:00"));

  // Rules 1 and 21: another client, with OAuth or with an API key, sees the same data.
  const cursor = await oauthConnect(page, "Cursor");
  expect(await cursor.tool<Listed>("list_events", day(tue))).toEqual(listed);
  await page.goto("/account");
  const keyed = await connect(request, await createKey(page, "Other client"));
  expect(await keyed.tool("list_events", day(tue))).toEqual(listed);

  // Rule 3: a write is staged, named after the client, and reaches the calendar at apply only.
  const staged = await claude.tool<{ id: string; review_url: string }>("propose_create_event", {
    title: "Write report",
    start: iso(at(wed, "15:00")),
    end: iso(at(wed, "16:00")),
    reason: "You asked for an hour of writing.",
  });
  expect(staged.review_url).toBe(`${BASE_URL}/?week=${W}`);
  await planNow(page);
  expect(named(await weekEvents(cal), "Write report")).toHaveLength(0);
  await page.goto(staged.review_url);
  const row = stagedRow(page, "Write report");
  await expect(row).toContainText("AI tool (Claude)");
  await expect(row).toContainText("hour of writing");
  await reviewAndApply(page);
  await expect(page.getByTestId("apply-summary")).toContainText("Applied 1");
  const [report] = named(
    await eventually(
      () => weekEvents(cal),
      (evs) => expect(named(evs, "Write report")).toHaveLength(1),
    ),
    "Write report",
  );
  expect(local(report?.start ?? 0)).toBe(`${wed} 15:00`);

  // Reload: the grants stay, with their last use; nothing is left staged.
  await page.reload();
  await expect(previewPanel(page).getByTestId("staged-change")).toHaveCount(0);
  await page.goto("/account");
  const grants = page.getByTestId("oauth-grants");
  await expect(grants.locator("[data-grant]")).toHaveCount(2);
  await expect(grants.locator('[data-grant="Claude"]')).toContainText("last used");
  await expect(grants.locator('[data-grant="Cursor"]')).toContainText("last used");
});

test("an AI tool answers an invitation, protects focus time and records a work session, each staged until the user applies it (integrations-ai-tools capability groups)", async ({
  page,
  cal,
  signIn,
}) => {
  // The plan of the task starts in the test week, at any time of day.
  await blockUntil(cal, W);
  const invite = await cal.addInvite({
    title: "Budget sync",
    start: at(wed, "10:00"),
    end: at(wed, "11:00"),
    answer: "NEEDS-ACTION",
  });
  await cal.addEvent({ title: "Team lunch", start: at(wed, "12:00"), end: at(wed, "13:00") });
  await signIn();
  await addTask(page, { title: "Onboarding guide", minutes: 240, due: "" });
  const ai = await oauthConnect(page, "Claude");

  // Find the invitation and the task, as the client would.
  const { events } = await eventually(
    () => ai.tool<Listed>("list_events", day(wed)),
    (r) => expect(r.events.map((e) => e.title)).toEqual(["Budget sync", "Team lunch"]),
  );
  const [sync, lunch] = events;
  expect(sync?.organizer_self).toBe(false);
  const { tasks } = await ai.tool<{ tasks: { id: string; title: string }[] }>("list_tasks");
  const task = tasks.find((t) => t.title === "Onboarding guide");
  expect(task).toBeTruthy();

  // Respond to invitations: "Decline the budget sync". Only invitations can be answered.
  await ai.tool("propose_rsvp", { event_id: sync?.id, response: "declined" });
  expect(
    await ai.toolError("propose_rsvp", { event_id: lunch?.id, response: "declined" }),
  ).toContain("not an invitation");

  // Protect focus time: "Reserve 2 hours of deep work on Thursday before noon".
  const focus = await ai.tool<{ summary: string }>("propose_focus_time", {
    duration_minutes: 120,
    start: iso(at(thu, "00:00")),
    end: iso(at(thu, "12:00")),
    title: "Deep work",
  });
  expect(focus.summary).toContain("Deep work");
  // Outside the work hours there is no room: nothing is staged.
  expect(
    await ai.toolError("propose_focus_time", {
      duration_minutes: 120,
      start: iso(at(thu, "18:00")),
      end: iso(at(thu, "23:00")),
    }),
  ).toContain("No free time");

  // Work sessions: "Record 90 minutes on the onboarding guide", yesterday at 10:00.
  const yesterday = addDays(utcToLocal(ZONE, Date.now()).date, -1);
  await ai.tool("propose_log_task_time", {
    task_id: task?.id,
    start: iso(at(yesterday, "10:00")),
    minutes: 90,
  });
  expect(
    await ai.toolError("propose_log_task_time", {
      task_id: task?.id,
      start: iso(Date.now() + 86_400_000),
      minutes: 30,
    }),
  ).toContain("future");

  // Nothing reached the calendar yet.
  const pastDay = () => cal.events(at(yesterday, "00:00"), at(addDays(yesterday, 1), "00:00"));
  await planNow(page);
  const before = await weekEvents(cal);
  expect(named(before, "Budget sync")[0]?.selfResponse).toBe("needsAction");
  expect(named(before, "Deep work")).toHaveLength(0);
  expect(managed(await pastDay())).toHaveLength(0);

  // The planner lists the three changes of the AI tool; the user applies them.
  await page.goto(`/?week=${W}`);
  await expect(previewPanel(page).getByTestId("staged-change")).toHaveCount(3);
  await expect(stagedRow(page, "Decline")).toContainText("AI tool (Claude)");
  await expect(stagedRow(page, "Deep work")).toContainText("AI tool (Claude)");
  await expect(stagedRow(page, "Onboarding guide")).toContainText("90 min");
  await reviewAndApply(page);
  await expect(page.getByTestId("apply-summary")).toContainText("Applied 3");

  const after = await eventually(
    () => weekEvents(cal),
    (evs) => {
      expect(named(evs, "Budget sync")[0]?.selfResponse).toBe("declined");
      expect(named(evs, "Deep work")).toHaveLength(1);
    },
  );
  const deep = named(after, "Deep work")[0];
  expect(local(deep?.start ?? 0)).toBe(`${thu} 09:00`);
  expect(local(deep?.end ?? 0)).toBe(`${thu} 11:00`);
  const [session] = await eventually(
    async () => managed(await pastDay()).filter((e) => e.summary.includes("Onboarding guide")),
    (l) => expect(l).toHaveLength(1),
  );
  expect(local(session?.start ?? 0)).toBe(`${yesterday} 10:00`);
  expect((session?.end ?? 0) - (session?.start ?? 0)).toBe(90 * MIN);

  // Analyze schedule: the focus block counts as focus time, and Thursday morning is no longer free.
  const week = await eventually(
    () =>
      ai.tool<{ days: { date: string; focus_hours: number }[] }>("get_week_summary", {
        week_start: W,
      }),
    (w) => expect(w.days.find((d) => d.date === thu)?.focus_hours).toBe(2),
  );
  expect(week.days.find((d) => d.date === wed)?.focus_hours).toBe(0);
  const { slots } = await ai.tool<{ slots: { start: string }[] }>("find_free_time", {
    duration_minutes: 60,
    ...day(thu),
  });
  expect(Date.parse(slots[0]?.start ?? "")).toBe(at(thu, "11:00"));

  // Reload: the changes are applied and stay.
  await page.reload();
  await expect(previewPanel(page).getByTestId("staged-change")).toHaveCount(0);
  expect(named(await weekEvents(cal), "Budget sync")[0]?.selfResponse).toBe("declined");
  expect(
    managed(await pastDay()).filter((e) => e.summary.includes("Onboarding guide")),
  ).toHaveLength(1);
  expect(invite).toBeTruthy();
});

test("revoking one AI tool on the Account page stops only that tool; calendar access, its events and its staged changes stay (integrations-ai-tools rules 6-8, edge case 1)", async ({
  page,
  cal,
  signIn,
}) => {
  await signIn();
  const claude = await oauthConnect(page, "Claude");
  const cursor = await oauthConnect(page, "Cursor");

  // Claude made one event (applied) and staged another one.
  await claude.tool("propose_create_event", {
    title: "Planning",
    start: iso(at(tue, "09:00")),
    end: iso(at(tue, "10:00")),
  });
  await page.goto(`/?week=${W}`);
  await reviewAndApply(page);
  await expect(page.getByTestId("apply-summary")).toContainText("Applied 1");
  await eventually(
    () => weekEvents(cal),
    (evs) => expect(named(evs, "Planning")).toHaveLength(1),
  );
  await claude.tool("propose_create_event", {
    title: "Retro",
    start: iso(at(thu, "14:00")),
    end: iso(at(thu, "15:00")),
  });
  // Claude's tokens work before the revoke.
  const access = claude.provider.saved?.access_token ?? "";
  expect(await statusWith(access)).toBe(200);

  await page.goto("/account");
  const grants = page.getByTestId("oauth-grants");
  await expect(grants.locator("[data-grant]")).toHaveCount(2);
  const revoked = page.waitForResponse(
    (r) => r.request().method() === "DELETE" && r.url().includes("/api/oauth/grants/"),
  );
  await grants.locator('[data-grant="Claude"]').getByRole("button", { name: "Revoke" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Revoke access" }).click();
  expect((await revoked).status()).toBe(204);
  await expect(grants.locator("[data-grant]")).toHaveCount(1);
  await expect(grants.locator('[data-grant="Cursor"]')).toBeVisible();

  // Claude can no longer call tools, nor get new tokens.
  expect(await statusWith(access)).toBe(401);
  expect(await refreshWith(claude.provider)).toEqual({ status: 400, error: "invalid_grant" });
  // Cursor still works; the calendar stays connected and keeps syncing.
  await expect(page.getByTestId("account-list")).toContainText("Connected");
  await cal.addEvent({ title: "After revoke", start: at(wed, "16:00"), end: at(wed, "17:00") });
  await eventually(
    () => cursor.tool<Listed>("list_events", day(wed)),
    (r) => expect(r.events.map((e) => e.title)).toEqual(["After revoke"]),
  );
  // Cursor's refresh still works (rotation gives new tokens).
  expect((await refreshWith(cursor.provider)).status).toBe(200);

  // Rule 7: the event Claude made stays; its staged change is not lost.
  expect(named(await weekEvents(cal), "Planning")).toHaveLength(1);
  await page.goto(`/?week=${W}`);
  await expect(stagedRow(page, "Retro")).toContainText("AI tool (Claude)");

  // Reload: only Cursor is listed. Claude can connect again with a new consent.
  await page.goto("/account");
  await page.reload();
  await expect(grants.locator("[data-grant]")).toHaveCount(1);
  await expect(grants.locator('[data-grant="Cursor"]')).toBeVisible();
  const again = await oauthConnect(page, "Claude");
  expect((await again.tool<Listed>("list_events", day(tue))).events.map((e) => e.title)).toEqual([
    "Planning",
  ]);
  await page.goto("/account");
  await expect(grants.locator("[data-grant]")).toHaveCount(2);
});
