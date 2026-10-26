// Assistant chat answers (docs/specs/assistant-chat.md rules 8-10; TSK-5):
// what to work on, events that could become automations, own stats and focus
// advice, who is away, organization analytics, questions about Tempoloom, and
// a new task by chat. The fake model (tests/e2e/fake-llm.ts) calls the tools;
// each test checks what the app sent it (tools, prompt, tool results from the
// real data) and what the panel, preview mode and the CalDAV calendar show,
// also after a reload.
//
// Ways this can fail, and the check that catches each:
// - a tool is missing, or reads other data than the page it mirrors       -> tool results = tasks panel, stats page, help page, copies
// - the model gets no guidance for a request                              -> system prompt parts
// - a read gives data the caller cannot see: another team's absences,
//   organization analytics for a member                                  -> outsider and member results
// - a task by chat is created before approval, or not after               -> tasks API and calendar before and after apply
// - focus advice writes focus time before approval                        -> calendar before and after apply
// - the help answer has no source, or invents one                         -> page link opens that help page; empty result
import type { Page } from "@playwright/test";
import { addDays } from "../../src/shared/time.ts";
import { CLIENT, lastWeek, meet, openStats, synced } from "./analytics-helpers.ts";
import { chatPanel, openAssistant, proposal, say } from "./assistant-helpers.ts";
import { putSeries } from "./automation-helpers.ts";
import { type ChatRequest, toolJson, toolResults } from "./fake-llm.ts";
import {
  at,
  BACKEND,
  blockUntil,
  type CalendarDriver,
  EMAIL,
  eventually,
  expect,
  local,
  planNow,
  REAL_LLM,
  test,
} from "./fixtures.ts";
import { addTask, W } from "./helpers.ts";
import { outOfOffice } from "./ics.ts";
import { iso, previewPanel, reviewAndApply, stagedRow } from "./preview-helpers.ts";
import { accept, invite, joinLink, openTeam } from "./team-helpers.ts";

const day = (n: number) => addDays(W, n);
const weekEvents = (cal: CalendarDriver) => cal.events(at(W, "00:00"), at(day(7), "00:00"));
const systemOf = (req: ChatRequest | undefined) =>
  req?.messages.find((m) => m.role === "system")?.content ?? "";
const toolsOf = (req: ChatRequest | undefined) => req?.tools?.map((t) => t.function.name) ?? [];
const answers = (p: Page) => chatPanel(p).getByTestId("chat-assistant");
const call = (name: string, args: Record<string, unknown> = {}) => ({
  tools: [{ name, arguments: args }],
});

interface Task {
  title: string;
  priority: number;
  remaining_minutes: number;
}

test("the chat suggests what to work on from the tasks panel's lists and names recurring events that could become a flexible meeting or a habit (assistant-chat rule 8; NXT-34)", async ({
  page,
  cal,
  radicale,
  signIn,
  llm,
}) => {
  test.skip(!radicale, "Recurring series are written to Radicale");
  if (!radicale) return;
  await putSeries(radicale, cal, {
    title: "Weekly sync",
    start: at(day(1), "14:00"),
    minutes: 30,
    byDay: "TU",
    attendees: ["dana@example.com"],
  });
  await putSeries(radicale, cal, {
    title: "Morning run",
    start: at(day(1), "07:00"),
    minutes: 45,
    byDay: "TU,TH",
  });
  await signIn();
  // Created first and at P4, so the order of creation does not give the answer.
  await addTask(page, { title: "Tidy inbox", minutes: 30, level: 4 });
  await addTask(page, { title: "Quarterly report", minutes: 60, level: 1 });

  llm.on(/what should i work on/i, [
    call("get_task_suggestions"),
    (req) => {
      const s = toolJson<{ suggested_now: Task[] }>(req, "get_task_suggestions").suggested_now;
      return { content: `Start with ${s.map((t) => t.title).join(", then ")}.` };
    },
  ]);
  llm.on(/become automations/i, [
    call("suggest_automations"),
    (req) => {
      const r = toolJson<{
        flexible_meetings: { title: string }[];
        habits: { title: string; link: string }[];
      }>(req, "suggest_automations");
      return {
        content: `Flexible meetings: ${r.flexible_meetings.map((m) => m.title).join(", ")}. Habits: ${r.habits.map((h) => `${h.title} (${h.link})`).join(", ")}.`,
      };
    },
  ]);

  await page.goto(`/?week=${W}`);
  await planNow(page);
  await openAssistant(page);
  expect(await say(page, "What should I work on now?")).toBe(200);
  await expect(answers(page)).toHaveText(["Start with Quarterly report, then Tidy inbox."]);
  const [first] = llm.requests;
  expect(toolsOf(first)).toEqual(
    expect.arrayContaining(["get_task_suggestions", "suggest_automations"]),
  );
  expect(systemOf(first)).toContain("call get_task_suggestions");
  // The same lists as the planner's tasks panel.
  const panel = (await (await page.request.get("/api/now/tasks")).json()) as {
    suggestedNow: { title: string }[];
  };
  const read = toolJson<{ suggested_now: Task[]; next_up: Task | null }>(
    llm.requests[1] as ChatRequest,
    "get_task_suggestions",
  );
  expect(read.suggested_now.map((t) => t.title)).toEqual(panel.suggestedNow.map((t) => t.title));
  expect(read.suggested_now[0]).toMatchObject({ priority: 1, remaining_minutes: 60 });

  // NXT-34: a short task, or another choice, from the same lists.
  llm.on(/something short/i, [
    call("get_task_suggestions"),
    (req) => {
      const s = toolJson<{ suggested_now: Task[] }>(req, "get_task_suggestions").suggested_now;
      const short = [...s].sort((a, b) => a.remaining_minutes - b.remaining_minutes)[0];
      return { content: `Try ${short?.title} (${short?.remaining_minutes} min).` };
    },
  ]);
  expect(await say(page, "Something short instead?")).toBe(200);
  await expect(answers(page).last()).toHaveText("Try Tidy inbox (30 min).");

  expect(await say(page, "Which of my events could become automations?")).toBe(200);
  await expect(answers(page).last()).toContainText(
    "Flexible meetings: Weekly sync. Habits: Morning run (",
  );
  const ideas = toolJson<{
    flexible_meetings: { title: string; attendees: string[]; link: string }[];
    habits: { title: string; days: string[]; time: string; minutes: number; link: string }[];
  }>(llm.requests.at(-1) as ChatRequest, "suggest_automations");
  expect(ideas.flexible_meetings).toEqual([
    expect.objectContaining({ title: "Weekly sync", attendees: ["dana@example.com"] }),
  ]);
  expect(ideas.habits).toEqual([
    expect.objectContaining({
      title: "Morning run",
      days: ["Tuesday", "Thursday"],
      time: "07:00",
      minutes: 45,
    }),
  ]);
  // Nothing was proposed or written: these are answers only.
  await expect(previewPanel(page).getByTestId("staged-change")).toHaveCount(0);

  // The links open the forms that make them, filled from the series.
  await page.goto(ideas.habits[0]?.link ?? "");
  await expect(page.getByTestId("habit-editor").getByLabel("Title")).toHaveValue("Morning run");
  await page.goto(ideas.flexible_meetings[0]?.link ?? "");
  await expect(page.getByTestId("meeting-form").getByLabel("Title")).toHaveValue("Weekly sync", {
    timeout: 60_000,
  });

  await page.goto(`/?week=${W}`);
  await openAssistant(page);
  await expect(answers(page)).toHaveText([
    "Start with Quarterly report, then Tidy inbox.",
    "Try Tidy inbox (30 min).",
    /^Flexible meetings: Weekly sync\. Habits: Morning run \(/,
  ]);
});

test("a task asked for in the chat is proposed with its fields and created only after approval; the scheduler then places it (planning-tasks TSK-5; assistant-chat rule 12)", async ({
  page,
  cal,
  signIn,
  llm,
}) => {
  await blockUntil(cal, W);
  await signIn();
  const due = at(day(4), "17:00");
  llm.on(/add a task/i, [
    call("propose_create_task", {
      title: "Write the budget",
      minutes: 90,
      priority: 2,
      due: iso(due),
      reason: "You asked for it.",
    }),
    { content: "I proposed the task “Write the budget”. It waits for your approval." },
  ]);
  await page.goto(`/?week=${W}`);
  await openAssistant(page);
  expect(await say(page, "Add a task: write the budget, 90 minutes, P2, due Friday 17:00")).toBe(
    200,
  );
  expect(toolsOf(llm.requests[0])).toContain("propose_create_task");
  expect(systemOf(llm.requests[0])).toContain("call propose_create_task");
  const card = proposal(page, "New task “Write the budget”");
  await expect(card).toContainText("90 min · P2 · due");
  await expect(card).toContainText("Waiting for your approval");

  // Nothing exists before approval: no task, no event.
  const tasks = async () =>
    (
      (await (await page.request.get("/api/tasks")).json()) as {
        tasks: { title: string; level: number; total_minutes: number; due_at: number | null }[];
      }
    ).tasks.filter((t) => t.title === "Write the budget");
  expect(await tasks()).toEqual([]);
  await planNow(page);
  expect((await weekEvents(cal)).filter((e) => e.summary.includes("Write the budget"))).toEqual([]);

  await page.reload();
  await expect(stagedRow(page, "Write the budget")).toContainText("Assistant chat");
  await expect(stagedRow(page, "Write the budget")).toContainText("You asked for it.");
  await openAssistant(page);
  await proposal(page, "Write the budget").getByRole("button", { name: "Accept" }).click();
  await expect(proposal(page, "Write the budget")).toContainText("Accepted");
  await chatPanel(page).getByRole("button", { name: "Close" }).click();
  await reviewAndApply(page);
  await expect(page.getByTestId("apply-summary")).toContainText("Applied 1");

  await expect
    .poll(tasks)
    .toEqual([expect.objectContaining({ level: 2, total_minutes: 90, due_at: due })]);
  const placed = await eventually(
    () => weekEvents(cal),
    (evs) =>
      expect(evs.filter((e) => e.summary.includes("Write the budget")).length).toBeGreaterThan(0),
  );
  const chunks = placed.filter((e) => e.summary.includes("Write the budget"));
  expect(chunks.reduce((m, e) => m + (e.end - e.start), 0)).toBe(90 * 60_000);
  for (const c of chunks) expect(c.end).toBeLessThanOrEqual(due);

  await page.reload();
  await page.getByRole("link", { name: "Tasks" }).click();
  await expect(page.locator('[data-task-title="Write the budget"]')).toBeVisible();
  await page.goto(`/?week=${W}`);
  await expect(previewPanel(page).getByTestId("staged-change")).toHaveCount(0);
  await openAssistant(page);
  await expect(proposal(page, "Write the budget")).toContainText("Applied");
});

test("the chat answers about the user's own stats with the stats page's numbers and stages focus time as advice, written only after approval (analytics-personal-stats rule 14, open question 6; assistant-chat rule 9)", async ({
  page,
  cal,
  signIn,
  llm,
}) => {
  const tue = day(1);
  const wed = day(2);
  await cal.addEvent({
    title: "1:1 with Ana",
    start: at(tue, "14:00"),
    end: at(tue, "15:00"),
    attendees: ["ana@example.com"],
  });
  await cal.addEvent({
    title: "Team sync",
    start: at(tue, "15:00"),
    end: at(tue, "15:30"),
    attendees: ["ana@example.com", "ben@example.com"],
  });
  await signIn();
  const range = { start_date: W, end_date: day(6) };
  type Stats = { totals: Record<string, number>; highlights: { meetingMinutes: number } };
  llm.on(/meeting time go/i, [
    call("get_stats", range),
    (req) => {
      const s = toolJson<Stats>(req, "get_stats");
      return {
        content: `One-on-ones: ${s.totals.oneOnOne} min. Group meetings: ${s.totals.groupMeetings} min.`,
      };
    },
  ]);
  llm.on(/more focus/i, [
    call("get_stats", range),
    (req) => ({
      tools: [
        {
          name: "propose_focus_time",
          arguments: {
            duration_minutes: 120,
            start: iso(at(wed, "09:00")),
            end: iso(at(wed, "12:00")),
            reason: `You have ${toolJson<Stats>(req, "get_stats").totals.focus} min of focus time this week.`,
          },
        },
      ],
    }),
    {
      content:
        "Your week has 90 min of meetings and no focus time. I staged two hours on Wednesday morning.",
    },
  ]);

  await page.goto(`/?week=${W}`);
  await openAssistant(page);
  expect(await say(page, "Where did my meeting time go that week?")).toBe(200);
  await expect(answers(page)).toHaveText(["One-on-ones: 60 min. Group meetings: 30 min."]);
  expect(systemOf(llm.requests[0])).toContain("call get_stats");
  const stats = toolJson<Stats>(llm.requests[1] as ChatRequest, "get_stats");
  expect(stats.highlights.meetingMinutes).toBe(90);

  expect(await say(page, "How can I get more focus time?")).toBe(200);
  await expect(answers(page).last()).toContainText("I staged two hours on Wednesday morning.");
  // The advice came from the stats the app read for the model.
  const advice = llm.requests.at(-2) as ChatRequest;
  expect(toolResults(advice).map((r) => r.name)).toEqual(["get_stats"]);
  expect(toolJson<Stats>(advice, "get_stats").totals.focus).toBe(0);
  const card = proposal(page, "Focus time");
  await expect(card).toContainText("Waiting for your approval");

  // The stats page shows the same numbers as the chat's answer.
  await chatPanel(page).getByRole("button", { name: "Close" }).click();
  await page.goto(`/stats?from=${W}&to=${day(6)}`);
  await expect(page.getByTestId("stat-oneOnOne")).toHaveText("1 h");
  await expect(page.getByTestId("stat-groupMeetings")).toHaveText("30 min");

  // Nothing is written before approval.
  await page.goto(`/?week=${W}`);
  await planNow(page);
  expect((await weekEvents(cal)).filter((e) => e.summary === "Focus time")).toEqual([]);
  await openAssistant(page);
  await proposal(page, "Focus time").getByRole("button", { name: "Accept" }).click();
  await expect(proposal(page, "Focus time")).toContainText("Accepted");
  await chatPanel(page).getByRole("button", { name: "Close" }).click();
  await reviewAndApply(page);
  await expect(page.getByTestId("apply-summary")).toContainText("Applied 1");
  const focus = await eventually(
    async () => (await weekEvents(cal)).filter((e) => e.summary === "Focus time"),
    (evs) => expect(evs).toHaveLength(1),
  );
  const [f] = focus;
  expect(local(f?.start ?? 0) >= `${wed} 09:00`).toBe(true);
  expect(local(f?.end ?? 0) <= `${wed} 12:00`).toBe(true);
  expect((f?.end ?? 0) - (f?.start ?? 0)).toBe(120 * 60_000);

  await page.reload();
  await openAssistant(page);
  await expect(answers(page).first()).toHaveText("One-on-ones: 60 min. Group meetings: 30 min.");
  await expect(proposal(page, "Focus time")).toContainText("Applied");
});

test("the chat answers who is away from the team's out-of-office calendar; a person of another team gets no absence of this team (teams-ooo-calendar open question 7)", async ({
  page,
  cal,
  signIn,
  colleague,
  people,
  mail,
  llm,
}) => {
  test.skip(BACKEND === "google", "Out-of-office copies use CalDAV shared calendars.");
  await signIn();
  const pb = await colleague.signIn();
  await invite(page, [colleague.email]);
  await accept(pb, joinLink((await mail.message(colleague.email, /invited you/)).text));
  const shared = await cal.newCalendar("Shared");
  await outOfOffice(colleague.cal.calendarId, "Vacation", { from: day(2), to: day(4) });
  await openTeam(page);
  const section = page.getByTestId("ooo");
  await section.getByRole("button", { name: "Add a calendar" }).click();
  const form = page.getByTestId("ooo-form");
  await form.getByLabel("Name").fill("Team OOO");
  await form.getByLabel("Shared calendar").selectOption({ label: "Shared" });
  await form.getByRole("button", { name: "Create" }).click();
  await expect(section.locator('[data-ooo="Team OOO"]')).toBeVisible();
  await eventually(
    async () => (await shared.events(at(W, "00:00"), at(day(7), "00:00"))).map((e) => e.summary),
    (l) => expect(l).toEqual(["e2e2 out of office"]),
    60_000,
  );

  const range = { start_date: W, end_date: day(6) };
  type Away = {
    out_of_office_calendars: number;
    absences: { name: string; email: string; start: string; end: string; all_day: boolean }[];
  };
  const reply = (req: ChatRequest) => {
    const r = toolJson<Away>(req, "list_team_time_away");
    return {
      content: r.absences.length
        ? r.absences.map((a) => `${a.name} is away from ${a.start} to ${a.end}.`).join(" ")
        : `Nobody is away (${r.out_of_office_calendars} out-of-office calendars).`,
    };
  };
  llm.on(/who is away/i, [call("list_team_time_away", range), reply]);

  await page.goto(`/?week=${W}`);
  await openAssistant(page);
  expect(await say(page, "Who is away next week?")).toBe(200);
  await expect(answers(page)).toHaveText([`e2e2 is away from ${day(2)} to ${day(3)}.`]);
  expect(toolsOf(llm.requests[0])).toContain("list_team_time_away");
  expect(systemOf(llm.requests[0])).toContain("call list_team_time_away");
  expect(toolJson<Away>(llm.requests[1] as ChatRequest, "list_team_time_away")).toEqual({
    from: W,
    to: day(6),
    out_of_office_calendars: 1,
    absences: [{ name: "e2e2", email: colleague.email, start: day(2), end: day(3), all_day: true }],
  });

  // A person of another team asks the same: none of this team's absences.
  const outsider = await people(3);
  const pc = await outsider.signIn();
  await pc.goto(`/?week=${W}`);
  await openAssistant(pc);
  expect(await say(pc, "Who is away next week, please?")).toBe(200);
  await expect(answers(pc)).toHaveText(["Nobody is away (0 out-of-office calendars)."]);
  expect(
    toolJson<Away>(llm.requests.at(-1) as ChatRequest, "list_team_time_away").absences,
  ).toEqual([]);

  await page.reload();
  await openAssistant(page);
  await expect(answers(page)).toHaveText([`e2e2 is away from ${day(2)} to ${day(3)}.`]);
});

test("the chat answers organization analytics with the organization page's numbers for an analytics admin and refuses a member (analytics-organization rules 9, 11; assistant-chat rule 9)", async ({
  page,
  app,
  cal,
  signIn,
  colleague,
  people,
  mail,
  llm,
}) => {
  test.skip(BACKEND === "google", "Organization analytics E2E uses several CalDAV users.");
  test.setTimeout(240_000);
  const P = lastWeek();
  const p3 = await people(3);
  // Meetings last week: 3 h, 2 h and 1 h, so 2 h per person.
  await meet(cal, P, "09:00", "12:00", "Customer meeting", [CLIENT]);
  await meet(colleague.cal, P, "09:00", "11:00", "Customer meeting", [CLIENT]);
  await meet(p3.cal, P, "09:00", "10:00", "Customer meeting", [CLIENT]);
  await signIn();
  const pb = await colleague.signIn();
  const pc = await p3.signIn();
  await invite(page, [colleague.email, p3.email]);
  await accept(pb, joinLink((await mail.message(colleague.email, /invited you/)).text));
  await accept(pc, joinLink((await mail.message(p3.email, /invited you/)).text));
  await synced(app, [EMAIL, colleague.email, p3.email]);

  const range = { start_date: P, end_date: addDays(P, 6) };
  type Org = {
    groups: {
      label: string;
      people: number;
      periods: { metrics: Record<string, number | null> | null }[];
    }[];
  };
  llm.on(/meetings across the company/i, [
    call("get_org_analytics", range),
    (req) => {
      const r = toolResults(req).find((x) => x.name === "get_org_analytics");
      if (r?.content.startsWith("Error:")) return { content: `I cannot: ${r.content}` };
      const g = toolJson<Org>(req, "get_org_analytics").groups[0];
      return {
        content: `${g?.label}: ${g?.periods[0]?.metrics?.meeting_hours_per_person_week} h of meetings per person, ${g?.people} people.`,
      };
    },
  ]);

  await page.goto(`/?week=${W}`);
  await openAssistant(page);
  expect(await say(page, "How many hours of meetings across the company last week?")).toBe(200);
  await expect(answers(page)).toHaveText(["Company: 2 h of meetings per person, 3 people."]);
  expect(toolsOf(llm.requests[0])).toContain("get_org_analytics");
  expect(systemOf(llm.requests[0])).toContain("call get_org_analytics");

  // The organization page shows the same number.
  await chatPanel(page).getByRole("button", { name: "Close" }).click();
  await openStats(page, "Organization");
  const report = page.getByTestId("org-analytics");
  await report.getByRole("button", { name: "Last week" }).click();
  await report.getByLabel("Group by").selectOption({ label: "Company" });
  await expect(
    report.locator('[data-group="Company"] [data-metric="meetings"] [data-period="0"]'),
  ).toHaveText("2 h");

  // A member is not an analytics admin: the tool refuses, and the chat says so.
  await pb.goto(`/?week=${W}`);
  await openAssistant(pb);
  expect(await say(pb, "Meetings across the company last week, please")).toBe(200);
  await expect(answers(pb)).toHaveText([/^I cannot: Error: Only analytics admins/]);
  expect(toolResults(llm.requests.at(-1) as ChatRequest)[0]?.content).not.toContain("Company");

  await page.goto(`/?week=${W}`);
  await openAssistant(page);
  await expect(answers(page)).toHaveText(["Company: 2 h of meetings per person, 3 people."]);
});

test("the chat answers how Tempoloom works from the help pages with the page's link, and says when the help does not cover a question (assistant-chat rule 10)", async ({
  page,
  signIn,
  llm,
}) => {
  await signIn();
  type Help = { pages: { title: string; link: string; text: string }[] };
  const reply = (req: ChatRequest) => {
    const [top] = toolJson<Help>(req, "search_help").pages;
    return {
      content: top ? `${top.title}: see ${top.link}.` : "The help does not cover this.",
    };
  };
  llm.on(/habit keeps coming back/i, [
    call("search_help", { query: "habit keeps coming back after I delete its event" }),
    reply,
  ]);
  llm.on(/order pizza/i, [call("search_help", { query: "order pizza" }), reply]);

  await page.goto(`/?week=${W}`);
  await openAssistant(page);
  expect(await say(page, "My habit keeps coming back after I delete its event. Why?")).toBe(200);
  await expect(answers(page)).toHaveText([
    "Events come back after you delete them: see /help/events-come-back.",
  ]);
  expect(toolsOf(llm.requests[0])).toContain("search_help");
  expect(systemOf(llm.requests[0])).toContain("call search_help");
  const found = toolJson<Help>(llm.requests[1] as ChatRequest, "search_help").pages[0];
  expect(found?.text).toContain(
    "Habit: delete the habit, or turn the habit off, on the Habits (/habits) page.",
  );

  expect(await say(page, "Can Tempoloom order pizza?")).toBe(200);
  await expect(answers(page).last()).toHaveText("The help does not cover this.");
  expect(toolJson<Help>(llm.requests.at(-1) as ChatRequest, "search_help").pages).toEqual([]);

  // The source is the help page itself.
  await page.goto(found?.link ?? "");
  const help = page.getByTestId("help-page");
  await expect(help.getByRole("heading", { level: 1 })).toHaveText(found?.title ?? "");
  await expect(help).toContainText(
    "Habit: delete the habit, or turn the habit off, on the Habits page.",
  );
  await expect(help.getByRole("link", { name: "Habits" })).toHaveAttribute("href", "/habits");

  await page.goto(`/?week=${W}`);
  await openAssistant(page);
  await expect(answers(page)).toHaveText([
    "Events come back after you delete them: see /help/events-come-back.",
    "The help does not cover this.",
  ]);
});

test("a task asked for in plain words is proposed in the chat and created only after approval @llm-real", async ({
  page,
  cal,
  signIn,
}) => {
  test.skip(!REAL_LLM, "Needs the real model: run scripts/e2e-llm.sh");
  test.setTimeout(400_000);
  await blockUntil(cal, W);
  await signIn();
  await page.goto(`/?week=${W}`);
  await openAssistant(page);
  expect(
    await say(
      page,
      "Please add a task titled “Renew passport” that needs 60 minutes, priority P2. Propose it directly; do not ask me questions.",
      150_000,
    ),
  ).toBe(200);
  const card = chatPanel(page).getByTestId("chat-proposal").filter({ hasText: "Renew passport" });
  await expect(card.first()).toContainText("Waiting for your approval");
  const tasks = async () =>
    ((await (await page.request.get("/api/tasks")).json()) as { tasks: { title: string }[] }).tasks
      .map((t) => t.title)
      .filter((t) => /renew passport/i.test(t));
  expect(await tasks()).toEqual([]);

  await chatPanel(page).getByRole("button", { name: "Close" }).click();
  await page.reload();
  await expect(previewPanel(page).getByTestId("staged-change").first()).toBeVisible();
  await reviewAndApply(page);
  await expect(page.getByTestId("apply-summary")).toContainText(/Applied [1-9]/);
  await expect.poll(tasks).toHaveLength(1);
  await eventually(
    () => weekEvents(cal),
    (evs) => expect(evs.some((e) => /renew passport/i.test(e.summary))).toBe(true),
  );
});
