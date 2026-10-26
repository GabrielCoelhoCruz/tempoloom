// Assistant chat for automations, team policies and the schedule review
// (docs/specs/assistant-chat.md rules 6, 7, 15-20; automations-overview.md
// rules 1, 5; teams-policies.md rule 1; meetings-flexible-rescheduling.md rule
// 24), with the fake model (tests/e2e/fake-llm.ts). Each test checks the
// request the app sent to the model (tools, prompt, the dates and the review
// it read), the proposals in the chat and in preview mode, and the calendar
// and the saved settings before and after apply.
//
// Ways this can fail, each covered below:
// - the chat has no automation or policy tool, or a staged change saves before
//   apply, or not after; a field the API refuses is staged anyway;
// - a member who is not a team admin can stage a team policy;
// - the review misses an issue of the dates shown, or lists one of other dates;
//   a fix is written before apply, or a discarded fix is written;
// - a group move writes before apply, or a meeting of another organizer moves;
// - the daily digest has no fixes staged, no link to them, or the link does
//   not open the chat with them.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Page } from "@playwright/test";
import { addDays } from "../../src/shared/time.ts";
import { chatPanel, openAssistant, proposal, say } from "./assistant-helpers.ts";
import { type ChatRequest, lastUser, type Step, toolJson, toolResults } from "./fake-llm.ts";
import {
  type AppServer,
  at,
  BACKEND,
  blockUntil,
  type CalendarDriver,
  COLLEAGUE_EMAIL,
  EMAIL,
  eventually,
  expect,
  local,
  planNow,
  REAL_LLM,
  test,
} from "./fixtures.ts";
import { titled, W } from "./helpers.ts";
import { putMeeting, rawEvent } from "./meeting-helpers.ts";
import { openPolicies, policyRow } from "./policy-helpers.ts";
import { iso, previewPanel, reviewAndApply, stagedRow } from "./preview-helpers.ts";
import { teamOfTwo } from "./team-helpers.ts";

test.skip(BACKEND === "google", "These tests write guests and answers on CalDAV.");

const tue = addDays(W, 1);
const wed = addDays(W, 2);
const thu = addDays(W, 3);
const fri = addDays(W, 4);
const ZOOM = "Join https://zoom.us/j/123456789";
const LINK = "https://zoom.us/j/555000111";
const weekEvents = (cal: CalendarDriver, monday = W) =>
  cal.events(at(monday, "00:00"), at(addDays(monday, 7), "00:00"));
const named = <T extends { summary: string }>(evs: T[], title: string) =>
  evs.filter((e) => e.summary === title);
const systemOf = (req: ChatRequest | undefined) =>
  req?.messages.find((m) => m.role === "system")?.content ?? "";
const toolNames = (req: ChatRequest | undefined) => req?.tools?.map((t) => t.function.name) ?? [];
/** The requests of the turns whose user message matches. */
const turnsOf = (requests: ChatRequest[], match: RegExp) =>
  requests.filter((r) => match.test(lastUser(r)));

interface Issue {
  check: string;
  event_id: string;
  title: string;
  start: string;
  end: string;
  message: string;
}
interface Review {
  issues: Issue[];
  recommendations: { kind: string; text: string }[];
}
const REVIEW =
  /^Recommendations: review my schedule from (\d{4}-\d{2}-\d{2}) to (\d{4}-\d{2}-\d{2})/;

/** The model's first step for a review request: review_schedule for the dates in the request. */
const reviewStep = (req: ChatRequest): Step => {
  const m = REVIEW.exec(lastUser(req));
  if (!m) throw new Error("not a review request");
  return {
    tools: [
      {
        name: "review_schedule",
        arguments: { from: m[1], to_exclusive: addDays(m[2] as string, 1) },
      },
    ],
  };
};
const issueOf = (req: ChatRequest, check: string, title: string) => {
  const i = toolJson<Review>(req, "review_schedule").issues.find(
    (x) => x.check === check && x.title === title,
  );
  if (!i) throw new Error(`no ${check} issue for ${title}`);
  return i;
};
const listed = (req: ChatRequest) =>
  toolJson<Review>(req, "review_schedule")
    .issues.map((i) => `${i.title} (${i.check})`)
    .join("; ");

/** Runs the server's email worker at `t` (CLI), without blocking the fake model in this process. */
async function emailWorkerAt(app: AppServer, t: number): Promise<void> {
  await promisify(execFile)(
    process.execPath,
    ["src/server/cli.ts", "weekly-reports", "--now", new Date(t).toISOString()],
    { env: app.env, cwd: process.cwd() },
  );
}

async function stagedCount(app: AppServer, email: string): Promise<number> {
  return (
    app.query<{ n: number }>(
      `SELECT count(*) AS n FROM staged_changes s JOIN users u ON u.id = s.user_id
       WHERE u.email = ? AND s.state IN ('pending', 'accepted')`,
      email,
    )[0]?.n ?? 0
  );
}

async function openPlanner(page: Page, monday = W) {
  await page.goto(`/?week=${monday}`);
  await expect(page.getByTestId("week-label")).toBeVisible();
}

test("automations by chat: a new habit, a focus goal change and a buffer turned off wait in preview mode with their calendar impact; a field the form refuses goes back to the model; nothing changes before apply (assistant-chat rule 7; automations-overview rules 1, 5)", async ({
  page,
  cal,
  signIn,
  llm,
  app,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await openPlanner(page);
  // Preview mode is off, so these form requests save at once.
  const made = await page.evaluate(async () => {
    const post = (path: string, body: unknown) =>
      fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }).then((r) => r.status);
    return [
      await post("/api/focus", { title: "Deep focus", weeklyGoalMinutes: 240 }),
      await post("/api/buffers", { title: "Meeting buffer", side: "after", minutesAfter: 15 }),
    ];
  });
  expect(made).toEqual([201, 201]);

  const lunch = (days: number[]) => ({
    tools: [
      {
        name: "propose_automation",
        arguments: {
          action: "create",
          type: "habit",
          settings: {
            title: "Lunch",
            idealTime: "12:00",
            minMinutes: 30,
            maxMinutes: 30,
            frequency: { period: "weekly", days },
          },
          reason: "You asked for a lunch break.",
        },
      },
    ],
  });
  const idIn = (req: ChatRequest, title: string) => {
    const a = toolJson<{ automations: { id: string; title: string }[] }>(
      req,
      "list_automations",
    ).automations.find((x) => x.title === title);
    if (!a) throw new Error(`no automation ${title}`);
    return a.id;
  };
  llm.on(/add a lunch habit/i, [
    // Day 9 does not exist: the form's check refuses it, and the model corrects it.
    lunch([1, 2, 3, 4, 5, 9]),
    lunch([1, 2, 3, 4, 5]),
    (req) => ({
      content: `I staged the Lunch habit. It adds ${
        toolJson<{ calendar_impact: unknown[] }>(req, "propose_automation").calendar_impact.length
      } events and waits for your approval.`,
    }),
  ]);
  llm.on(/focus goal to 6 hours/i, [
    { tools: [{ name: "list_automations", arguments: {} }] },
    (req) => ({
      tools: [
        {
          name: "propose_automation",
          arguments: {
            action: "edit",
            type: "focus_time",
            id: idIn(req, "Deep focus"),
            settings: { weeklyGoalMinutes: 360 },
          },
        },
      ],
    }),
    { content: "The new focus goal waits for your approval." },
  ]);
  llm.on(/turn off the meeting buffer/i, [
    { tools: [{ name: "list_automations", arguments: {} }] },
    (req) => ({
      tools: [
        {
          name: "propose_automation",
          arguments: { action: "turn_off", type: "buffer", id: idIn(req, "Meeting buffer") },
        },
      ],
    }),
    { content: "Turning off the buffer waits for your approval." },
  ]);

  await openAssistant(page);
  await say(page, "Add a lunch habit at noon on weekdays");
  await expect(proposal(page, "New habit “Lunch”")).toContainText("Waiting for your approval");
  const [first, second, third] = turnsOf(llm.requests, /lunch habit/i);
  expect(toolNames(first)).toEqual(
    expect.arrayContaining([
      "list_automations",
      "propose_automation",
      "list_team_policies",
      "propose_team_policy",
      "review_schedule",
      "propose_video_link",
    ]),
  );
  expect(systemOf(first)).toContain("propose_automation");
  // The dry run of the form request refused day 9; the model got the field and the message.
  const refused = toolResults(second as ChatRequest).at(-1)?.content ?? "";
  expect(refused).toMatch(/^Error: frequency/);
  // The staged habit plans events in the test week: the dry run gave its impact.
  const impact = toolJson<{ calendar_impact: { op: string; title: string; start: string }[] }>(
    third as ChatRequest,
    "propose_automation",
  ).calendar_impact;
  // Lunch events are created; other planned events may move aside (the full plan difference).
  const lunches = impact.filter((i) => i.op === "create" && i.title.includes("Lunch"));
  expect(lunches.length).toBeGreaterThan(0);
  for (const l of lunches) expect(local(Date.parse(l.start)).slice(11)).toBe("12:00");
  await expect(chatPanel(page).getByTestId("chat-assistant").last()).toHaveText(
    `I staged the Lunch habit. It adds ${impact.length} events and waits for your approval.`,
  );

  await say(page, "Set my focus goal to 6 hours");
  await expect(proposal(page, "Edit focus goal “Deep focus”")).toContainText(
    "Waiting for your approval",
  );
  await say(page, "Turn off the meeting buffer");
  await expect(proposal(page, "Turn off buffer “Meeting buffer”")).toContainText(
    "Waiting for your approval",
  );

  // Rule 12: nothing is saved and nothing reaches the calendar before apply.
  const saved = () => ({
    lunch: app.query<{ n: number }>("SELECT count(*) AS n FROM habits WHERE title = 'Lunch'")[0]?.n,
    focus: app.query<{ m: number }>(
      "SELECT weekly_goal_minutes AS m FROM focus_goals WHERE title = 'Deep focus'",
    )[0]?.m,
    buffer: app.query<{ e: number }>(
      "SELECT enabled AS e FROM buffers WHERE title = 'Meeting buffer'",
    )[0]?.e,
  });
  expect(saved()).toEqual({ lunch: 0, focus: 240, buffer: 1 });
  await planNow(page);
  expect(titled(await weekEvents(cal), "Lunch")).toHaveLength(0);

  await page.reload();
  await expect(previewPanel(page).getByTestId("staged-change")).toHaveCount(3);
  for (const s of ["New habit “Lunch”", "Edit focus goal “Deep focus”", "Turn off buffer"])
    await expect(stagedRow(page, s)).toContainText("Assistant chat");
  await reviewAndApply(page);
  await expect(page.getByTestId("apply-summary")).toContainText("Applied 3");
  expect(saved()).toEqual({ lunch: 1, focus: 360, buffer: 0 });
  const after = await eventually(
    () => weekEvents(cal),
    (evs) => expect(titled(evs, "Lunch").length).toBeGreaterThan(0),
  );
  for (const e of titled(after, "Lunch")) expect(local(e.start).slice(11)).toBe("12:00");

  await page.reload();
  await expect(previewPanel(page).getByTestId("staged-change")).toHaveCount(0);
  await openAssistant(page);
  await expect(proposal(page, "New habit “Lunch”")).toContainText("Applied");
  await expect(proposal(page, "Turn off buffer “Meeting buffer”")).toContainText("Applied");
});

test("team policies by chat: an admin's new policy and its change wait in preview mode and reach the team only after apply; a member who is not an admin stages nothing (assistant-chat rule 7; teams-policies rule 1)", async ({
  page,
  signIn,
  colleague,
  mail,
  llm,
  app,
}) => {
  const pb = await teamOfTwo(page, signIn, colleague, mail);
  llm.on(/create a team focus policy/i, [
    {
      tools: [
        {
          name: "propose_team_policy",
          arguments: {
            action: "create",
            type: "focus_time",
            name: "Team focus",
            goal: { weeklyGoalMinutes: 480 },
            enabled: true,
          },
        },
      ],
    },
    (req) => ({ content: `Result: ${toolResults(req).at(-1)?.content.slice(0, 120)}` }),
  ]);
  llm.on(/turn off the team focus policy/i, [
    { tools: [{ name: "list_team_policies", arguments: {} }] },
    (req) => ({
      tools: [
        {
          name: "propose_team_policy",
          arguments: {
            action: "edit",
            id: toolJson<{ policies: { id: string; name: string }[] }>(
              req,
              "list_team_policies",
            ).policies.find((p) => p.name === "Team focus")?.id,
            enabled: false,
          },
        },
      ],
    }),
    { content: "Turning it off waits for your approval." },
  ]);
  const policies = () =>
    app.query<{ name: string; enabled: number; goal: string }>(
      "SELECT name, enabled, goal FROM team_policies",
    );

  await openPlanner(page);
  await openAssistant(page);
  await say(page, "Create a team focus policy of 8 hours for everyone");
  await expect(proposal(page, "New team policy “Team focus” (on)")).toContainText(
    "Waiting for your approval",
  );
  expect(policies()).toEqual([]);
  await openPolicies(page);
  await expect(policyRow(page, "Team focus")).toHaveCount(0);

  await openPlanner(page);
  await expect(stagedRow(page, "New team policy “Team focus”")).toContainText("Assistant chat");
  await reviewAndApply(page);
  await expect(page.getByTestId("apply-summary")).toContainText("Applied 1");
  expect(policies()).toEqual([
    { name: "Team focus", enabled: 1, goal: JSON.stringify({ weeklyGoalMinutes: 480 }) },
  ]);
  await openPolicies(page);
  await page.reload();
  await expect(policyRow(page, "Team focus")).toBeVisible();

  await openPlanner(page);
  await openAssistant(page);
  await say(page, "Turn off the team focus policy");
  await expect(proposal(page, "Edit team policy “Team focus” (turn off)")).toContainText(
    "Waiting for your approval",
  );
  expect(policies()[0]?.enabled).toBe(1);
  await chatPanel(page).getByRole("button", { name: "Close" }).click();
  await reviewAndApply(page);
  await expect(page.getByTestId("apply-summary")).toContainText("Applied 1");
  expect(policies()[0]?.enabled).toBe(0);

  // A member asks for the same: the tool refuses, nothing is staged, the policy stays.
  await openPlanner(pb);
  await openAssistant(pb);
  await say(pb, "Create a team focus policy of 8 hours for everyone");
  await expect(chatPanel(pb).getByTestId("chat-assistant").last()).toContainText(
    "Result: Error: Only a team admin can change team policies",
  );
  await expect(chatPanel(pb).getByTestId("chat-proposal")).toHaveCount(0);
  expect(await stagedCount(app, COLLEAGUE_EMAIL)).toBe(0);
  expect(policies()).toHaveLength(1);
  await pb.reload();
  await expect(previewPanel(pb).getByTestId("staged-change")).toHaveCount(0);
});

test("Recommendations reviews the dates shown in the planner: the chat lists the conflict, the unanswered invitation, the missing video link and the guest who declined with a staged fix each; a discarded fix is not written, the others are after apply; another week reviews that week (assistant-chat rules 6, 16, 19, 20, T2, T5; meeting checks rule 6)", async ({
  page,
  cal,
  signIn,
  llm,
}) => {
  const c = cal.calendarId;
  const guest = (email: string, answer: "ACCEPTED" | "DECLINED" = "ACCEPTED") => [
    { email, answer } as const,
  ];
  const ids = {
    design: await putMeeting(c, {
      title: "Design sync",
      start: at(tue, "10:00"),
      end: at(tue, "11:00"),
      organizer: EMAIL,
      attendees: guest("dana@example.com"),
      description: ZOOM,
    }),
    vendor: await putMeeting(c, {
      title: "Vendor call",
      start: at(tue, "10:30"),
      end: at(tue, "11:30"),
      organizer: EMAIL,
      attendees: guest("erin@example.com"),
      description: ZOOM,
    }),
    retro: await putMeeting(c, {
      title: "Retro",
      start: at(thu, "14:00"),
      end: at(thu, "14:30"),
      organizer: EMAIL,
      attendees: guest("dana@example.com"),
    }),
    pricing: await putMeeting(c, {
      title: "Pricing review",
      start: at(thu, "16:00"),
      end: at(thu, "16:30"),
      organizer: EMAIL,
      attendees: guest("frank@example.com", "DECLINED"),
      description: ZOOM,
    }),
    next: await putMeeting(c, {
      title: "Next week sync",
      start: at(addDays(W, 8), "10:00"),
      end: at(addDays(W, 8), "10:30"),
      organizer: EMAIL,
      attendees: guest("dana@example.com"),
    }),
  };
  await cal.addInvite({
    title: "Board prep",
    start: at(wed, "09:00"),
    end: at(wed, "09:30"),
    answer: "NEEDS-ACTION",
    description: ZOOM,
  });
  await signIn();
  await openPlanner(page);
  await expect(page.locator(".ev", { hasText: "Pricing review" })).toBeVisible();

  llm.on(REVIEW, [
    reviewStep,
    (req) => {
      const r = toolJson<Review>(req, "review_schedule");
      // Another week: one issue, nothing to fix without a link.
      if (!r.issues.some((i) => i.title === "Design sync"))
        return { content: `Issues: ${listed(req)}. Send me a video link to fix it.` };
      return {
        tools: [
          {
            name: "propose_update_event",
            arguments: {
              event_id: issueOf(req, "conflict", "Design sync").event_id,
              start: iso(at(tue, "13:00")),
              end: iso(at(tue, "14:00")),
              reason: "It overlaps with Vendor call.",
            },
          },
          {
            name: "propose_rsvp",
            arguments: {
              event_id: issueOf(req, "rsvp_reminder", "Board prep").event_id,
              response: "accepted",
            },
          },
          {
            name: "propose_video_link",
            arguments: { event_id: issueOf(req, "video_link", "Retro").event_id, link: LINK },
          },
          {
            name: "propose_update_event",
            arguments: {
              event_id: issueOf(req, "attendee_availability", "Pricing review").event_id,
              start: iso(at(fri, "16:00")),
              end: iso(at(fri, "16:30")),
            },
          },
        ],
      };
    },
    (req) => ({ content: `Issues: ${listed(req)}. Each fix waits for your approval.` }),
  ]);

  await openAssistant(page);
  const sent = page.waitForResponse(
    (r) => r.url().endsWith("/api/assistant/messages") && r.request().method() === "POST",
  );
  await chatPanel(page).getByRole("button", { name: "Recommendations" }).click();
  expect((await sent).status()).toBe(200);
  const shown = `Recommendations: review my schedule from ${W} to ${addDays(W, 6)} and stage a fix for each issue.`;
  await expect(chatPanel(page).getByTestId("chat-user")).toHaveText([shown]);
  const [ask, fixes] = turnsOf(llm.requests, REVIEW);
  // The request carries the dates shown in the planner, and the model gets the review rules.
  expect(systemOf(ask)).toContain(`"from": "${W}"`);
  expect(systemOf(ask)).toContain(`"to_exclusive": "${addDays(W, 7)}"`);
  expect(systemOf(ask)).toContain("review_schedule");
  // The review read the issues of the week shown, and not the next week's.
  const review = toolJson<Review>(fixes as ChatRequest, "review_schedule");
  expect(review.issues.map((i) => `${i.check} ${i.title}`).sort()).toEqual([
    "attendee_availability Pricing review",
    "conflict Design sync",
    "rsvp_reminder Board prep",
    "video_link Retro",
  ]);
  expect(review.issues.find((i) => i.title === "Pricing review")?.message).toBe(
    "frank@example.com declined",
  );
  await expect(chatPanel(page).getByTestId("chat-assistant").last()).toHaveText(
    `Issues: ${listed(fixes as ChatRequest)}. Each fix waits for your approval.`,
  );
  const cards = [
    "Move “Design sync”",
    "Accept “Board prep”",
    "Add a video link to “Retro”",
    "Move “Pricing review”",
  ];
  for (const s of cards) await expect(proposal(page, s)).toContainText("Waiting for your approval");

  // Nothing is written before apply (rule 12).
  await planNow(page);
  const before = await weekEvents(cal);
  expect(named(before, "Design sync").map((e) => local(e.start))).toEqual([`${tue} 10:00`]);
  expect(named(before, "Board prep")[0]?.selfResponse).toBe("needsAction");
  expect(await rawEvent(c, ids.retro)).not.toContain(LINK);

  // T5: after reload the findings and the staged fixes remain.
  await page.reload();
  await expect(previewPanel(page).getByTestId("staged-change")).toHaveCount(4);
  await openAssistant(page);
  for (const s of cards) await expect(proposal(page, s)).toContainText("Waiting for your approval");
  // T2: discard one fix, apply the others.
  await proposal(page, "Move “Pricing review”").getByRole("button", { name: "Discard" }).click();
  await expect(proposal(page, "Move “Pricing review”")).toContainText("Discarded");
  await chatPanel(page).getByRole("button", { name: "Close" }).click();
  await expect(previewPanel(page).getByTestId("staged-change")).toHaveCount(3);
  await reviewAndApply(page);
  await expect(page.getByTestId("apply-summary")).toContainText("Applied 3");
  const after = await eventually(
    () => weekEvents(cal),
    (evs) => expect(named(evs, "Design sync").map((e) => local(e.start))).toEqual([`${tue} 13:00`]),
  );
  expect(named(after, "Design sync").map((e) => local(e.end))).toEqual([`${tue} 14:00`]);
  expect(named(after, "Board prep")[0]?.selfResponse).toBe("accepted");
  expect(named(after, "Pricing review").map((e) => local(e.start))).toEqual([`${thu} 16:00`]);
  expect(named(after, "Vendor call").map((e) => local(e.start))).toEqual([`${tue} 10:30`]);
  expect(await rawEvent(c, ids.retro)).toContain(LINK);

  // Rule 20: the planner on the next week; Recommendations reviews that week.
  await page.reload();
  await page.getByRole("button", { name: "Next week" }).click();
  await expect(page.locator(".ev", { hasText: "Next week sync" })).toBeVisible();
  await openAssistant(page);
  await chatPanel(page).getByRole("button", { name: "Recommendations" }).click();
  const next = addDays(W, 7);
  await expect(chatPanel(page).getByTestId("chat-user").last()).toHaveText(
    `Recommendations: review my schedule from ${next} to ${addDays(next, 6)} and stage a fix for each issue.`,
  );
  await expect(chatPanel(page).getByTestId("chat-assistant").last()).toHaveText(
    "Issues: Next week sync (video_link). Send me a video link to fix it.",
  );
  const later = turnsOf(llm.requests, REVIEW).at(-1);
  expect(systemOf(later)).toContain(`"from": "${next}"`);
  expect(await rawEvent(c, ids.next)).not.toContain(LINK);
});

test("moving a week of meetings by chat stages one move per meeting the user organizes; the calendar changes only after apply, and an invitation from someone else stays (meetings-flexible-rescheduling rule 24; assistant-chat rule 6)", async ({
  page,
  cal,
  signIn,
  llm,
}) => {
  const c = cal.calendarId;
  const own = [
    ["Kickoff", W, "09:00"],
    ["Roadmap", tue, "11:00"],
    ["Hiring sync", thu, "15:00"],
  ] as const;
  for (const [title, day, time] of own)
    await putMeeting(c, {
      title,
      start: at(day, time),
      end: at(day, time) + 30 * 60_000,
      organizer: EMAIL,
      attendees: [{ email: "dana@example.com", answer: "ACCEPTED" }],
      description: ZOOM,
    });
  await cal.addInvite({
    title: "All hands",
    start: at(wed, "16:00"),
    end: at(wed, "17:00"),
    answer: "ACCEPTED",
  });
  await signIn();
  await openPlanner(page);
  await expect(page.locator(".ev", { hasText: "Hiring sync" })).toBeVisible();

  interface Listed {
    events: { id: string; title: string; start: string; end: string; organizer_self: boolean }[];
  }
  llm.on(/conference/i, [
    {
      tools: [
        {
          name: "list_events",
          arguments: { start: iso(at(W, "00:00")), end: iso(at(addDays(W, 7), "00:00")) },
        },
      ],
    },
    (req) => ({
      tools: toolJson<Listed>(req, "list_events")
        .events.filter((e) => e.organizer_self)
        .map((e) => ({
          name: "propose_update_event",
          arguments: {
            event_id: e.id,
            start: iso(Date.parse(e.start) + 7 * 86_400_000),
            end: iso(Date.parse(e.end) + 7 * 86_400_000),
            reason: "You are at a conference this week.",
          },
        })),
    }),
    (req) => ({
      content: `I staged ${toolResults(req).filter((r) => r.name === "propose_update_event").length} moves.`,
    }),
  ]);

  await openAssistant(page);
  await say(
    page,
    "I am at a conference this week. Move all my meetings to the same times next week.",
  );
  await expect(chatPanel(page).getByTestId("chat-assistant").last()).toHaveText(
    "I staged 3 moves.",
  );
  const [ask] = turnsOf(llm.requests, /conference/i);
  expect(systemOf(ask)).toContain("propose_update_event once for each meeting the user organizes");
  for (const [title] of own)
    await expect(proposal(page, `Move “${title}”`)).toContainText("Waiting for your approval");
  await expect(chatPanel(page).getByTestId("chat-proposal")).toHaveCount(3);

  await planNow(page);
  const before = await weekEvents(cal);
  for (const [title, day, time] of own)
    expect(named(before, title).map((e) => local(e.start))).toEqual([`${day} ${time}`]);

  await page.reload();
  await expect(previewPanel(page).getByTestId("staged-change")).toHaveCount(3);
  await reviewAndApply(page);
  await expect(page.getByTestId("apply-summary")).toContainText("Applied 3");
  const next = await eventually(
    () => weekEvents(cal, addDays(W, 7)),
    (evs) => expect(own.flatMap(([t]) => named(evs, t))).toHaveLength(3),
  );
  for (const [title, day, time] of own)
    expect(named(next, title).map((e) => local(e.start))).toEqual([`${addDays(day, 7)} ${time}`]);
  const week = await weekEvents(cal);
  expect(own.flatMap(([t]) => named(week, t))).toHaveLength(0);
  expect(named(week, "All hands").map((e) => local(e.start))).toEqual([`${wed} 16:00`]);
  await page.reload();
  await expect(previewPanel(page).getByTestId("staged-change")).toHaveCount(0);
});

test("the daily review stages a fix for each open issue by assistant chat before the morning digest, and the digest link opens the chat with the fixes staged; they are written only after apply (assistant-chat rules 15-18; meeting checks rule 6)", async ({
  page,
  cal,
  signIn,
  llm,
  mail,
  app,
}) => {
  const c = cal.calendarId;
  const retro = await putMeeting(c, {
    title: "Retro",
    start: at(tue, "14:00"),
    end: at(tue, "14:30"),
    organizer: EMAIL,
    attendees: [{ email: "dana@example.com", answer: "ACCEPTED" }],
  });
  await cal.addInvite({
    title: "Board prep",
    start: at(wed, "09:00"),
    end: at(wed, "09:30"),
    answer: "NEEDS-ACTION",
    description: ZOOM,
  });
  await signIn();
  await openPlanner(page);
  await expect(page.locator(".ev", { hasText: "Board prep" })).toBeVisible();
  // The digest by email at 08:00: the next one is due before the test week.
  await page.getByRole("link", { name: "Meeting checks" }).click();
  const form = page.getByTestId("checks-form");
  await form.getByLabel("Daily digest").selectOption("email");
  await form.getByLabel("Digest time").fill("08:00");
  await form.getByRole("button", { name: "Save checks" }).click();
  await expect(form.getByTestId("checks-saved")).toHaveText("Saved");

  llm.on(REVIEW, [
    reviewStep,
    (req) => ({
      tools: [
        {
          name: "propose_rsvp",
          arguments: {
            event_id: issueOf(req, "rsvp_reminder", "Board prep").event_id,
            response: "accepted",
          },
        },
        {
          name: "propose_video_link",
          arguments: { event_id: issueOf(req, "video_link", "Retro").event_id, link: LINK },
        },
      ],
    }),
    (req) => ({ content: `Issues: ${listed(req)}. Each fix waits for your approval.` }),
  ]);

  // Monday 08:05 of the test week (a moved clock for the worker, order 29): the
  // review covers Monday to next Tuesday (rule 15), then the digest goes out.
  await emailWorkerAt(app, at(W, "08:05"));
  const digest = await eventually(
    () => mail.count(EMAIL, /^Meeting issues/),
    (n) => expect(n).toBe(1),
  ).then(() => mail.message(EMAIL, /^Meeting issues/));
  const [ask, fixes] = turnsOf(llm.requests, REVIEW);
  expect(lastUser(ask as ChatRequest)).toBe(
    `Recommendations: review my schedule from ${W} to ${addDays(W, 8)} and stage a fix for each issue.`,
  );
  expect(systemOf(ask)).toContain(`"from": "${W}"`);
  expect(systemOf(ask)).toContain(`"to_exclusive": "${addDays(W, 9)}"`);
  expect(toolNames(ask)).toContain("review_schedule");
  expect(listed(fixes as ChatRequest)).toBe("Retro (video_link); Board prep (rsvp_reminder)");
  expect(digest.text).toContain("Retro: No video link");
  expect(digest.text).toContain("Board prep: You have not answered this invitation");
  expect(digest.text).toContain("Assistant chat staged fixes for these issues");
  const link = /Review the fixes: (\S+)/.exec(digest.text)?.[1] ?? "";
  expect(link).toMatch(/\/\?assistant=[\w-]+$/);

  // Nothing reached the calendar.
  const answer = async () => named(await weekEvents(cal), "Board prep")[0]?.selfResponse;
  expect(await answer()).toBe("needsAction");
  expect(await rawEvent(c, retro)).not.toContain(LINK);

  // Rule 18: the link opens the planner with the chat and its staged fixes.
  await page.goto(link);
  await expect(chatPanel(page)).toBeVisible();
  for (const s of ["Accept “Board prep”", "Add a video link to “Retro”"])
    await expect(proposal(page, s)).toContainText("Waiting for your approval");
  await expect(chatPanel(page).getByTestId("chat-assistant")).toHaveText([
    "Issues: Retro (video_link); Board prep (rsvp_reminder). Each fix waits for your approval.",
  ]);
  await expect(stagedRow(page, "Add a video link to “Retro”")).toContainText("Assistant chat");
  await page.reload();
  await expect(previewPanel(page).getByTestId("staged-change")).toHaveCount(2);
  await reviewAndApply(page);
  await expect(page.getByTestId("apply-summary")).toContainText("Applied 2");
  await eventually(answer, (v) => expect(v).toBe("accepted"));
  expect(await rawEvent(c, retro)).toContain(LINK);
});

test("a real model stages a new habit by chat with the automation tool; it is saved only after apply @llm-real", async ({
  page,
  cal,
  signIn,
  app,
}) => {
  test.skip(!REAL_LLM, "Needs the real model: run scripts/e2e-llm.sh");
  test.setTimeout(400_000);
  await blockUntil(cal, W);
  await signIn();
  await openPlanner(page);
  await openAssistant(page);
  expect(
    await say(
      page,
      'Create a habit titled "Stretch" every weekday at 15:00 for 15 minutes. Stage it directly; do not ask me questions.',
      150_000,
    ),
  ).toBe(200);
  const card = chatPanel(page).getByTestId("chat-proposal").filter({ hasText: "Stretch" });
  await expect(card.first()).toContainText("Waiting for your approval");
  const stretch = () =>
    app.query<{ n: number }>("SELECT count(*) AS n FROM habits WHERE title LIKE '%Stretch%'")[0]?.n;
  expect(stretch()).toBe(0);
  await chatPanel(page).getByRole("button", { name: "Close" }).click();
  await page.reload();
  await reviewAndApply(page);
  await expect(page.getByTestId("apply-summary")).toContainText(/Applied [1-9]/);
  expect(stretch()).toBe(1);
  await eventually(
    () => weekEvents(cal),
    (evs) => expect(titled(evs, "Stretch").length).toBeGreaterThan(0),
  );
});
