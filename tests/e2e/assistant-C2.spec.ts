// The library's prompt entries and the other ways into assistant chat
// (automations-library.md rule 7; teams-settings-templates.md rule 15), with
// the fake OpenAI-compatible model (tests/e2e/fake-llm.ts). Each test checks
// what the app sent to the model (the prompt text, the planner dates, the
// tools and their results from the real calendar and tasks) and what the app
// did with the model's tool calls, against the real CalDAV server.
//
// Ways this can fail, each covered below:
// - a prompt entry offers no action, opens another page, or opens the chat
//   without its prompt, or sends it before the user does;
// - the user cannot edit the prompt, or the model gets the unedited text;
// - the model gets no planner dates, or the dates of another week than shown;
// - the model has no tool for the data a prompt asks about (tasks, stats,
//   team stats), or the tools read nothing real;
// - a change the model proposes (work time, a break, a priority, a meeting,
//   a move) reaches the calendar or the task before approval, or not after;
// - team stats show values for fewer than 3 members, or a member's own values.
// The chat offer after sign-up and the real-model test are in assistant-C2-offer.spec.ts.
import { addDays, diffDays, utcToLocal } from "../../src/shared/time.ts";
import { directory, lastWeek, meet, synced } from "./analytics-helpers.ts";
import { chatPanel, openAssistant, proposal } from "./assistant-helpers.ts";
import { type ChatRequest, lastUser, toolJson, toolResults } from "./fake-llm.ts";
import {
  at,
  BACKEND,
  blockUntil,
  EMAIL,
  eventually,
  expect,
  local,
  planNow,
  test,
} from "./fixtures.ts";
import { addTask, serverClockAt, titled, W } from "./helpers.ts";
import { iso, previewPanel, reviewAndApply } from "./preview-helpers.ts";

test.skip(BACKEND === "google", "Assistant chat E2E runs on CalDAV.");

import {
  expectLevels,
  type Listed,
  matches,
  named,
  openEntry,
  PROMPTS,
  plannerDates,
  prompt,
  RANKS,
  reply,
  type Slots,
  sendDraft,
  shownMonday,
  systemOf,
  type Tasks,
  toolNames,
  turnOf,
  weekOf,
  ZONE,
} from "./assistant-C2-helpers.ts";

test("every library prompt entry opens assistant chat in the planner with its prompt in the input box, and nothing goes to the model before the user sends (automations-library rule 7; entries 5, 6, 12, 14-18, 20-22, 24, 31)", async ({
  page,
  signIn,
  llm,
}) => {
  await signIn();
  for (const name of Object.keys(PROMPTS)) {
    await openEntry(page, name);
    await expect(chatPanel(page).getByTestId("assistant-log")).toBeVisible();
  }
  // Each entry is offered in the Prompts tab, with no other action and no "Added" badge.
  await page.getByRole("link", { name: "Library" }).click();
  await page.getByRole("tab", { name: "Prompts" }).click();
  const entries = page.getByTestId("library-entry");
  await expect(entries).toHaveCount(Object.keys(PROMPTS).length);
  for (const name of Object.keys(PROMPTS)) {
    const row = page.locator(`[data-entry="${name}"]`);
    await expect(row.getByRole("button")).toHaveText(["Open in chat"]);
    await expect(row).not.toContainText("Added");
  }
  expect(llm.requests).toHaveLength(0);
  // A reload keeps the entries; opening one after it still fills the input box.
  await page.reload();
  await openEntry(page, "What to do now");
  expect(llm.requests).toHaveLength(0);
});

test("task prompts reach the model with the planner dates and the open tasks; proposed work time, a break and a re-ranking that raises one task and lowers two wait in preview mode, and all apply together (library entries 5, 6, 22, 24; assistant-chat rules 8, 12)", async ({
  page,
  cal,
  signIn,
  llm,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await addTask(page, { title: "Quarterly report", minutes: 120, due: `${addDays(W, 4)}T17:00` });
  await addTask(page, {
    title: "Budget review",
    minutes: 60,
    due: `${addDays(W, 2)}T17:00`,
    level: 3,
  });
  await addTask(page, {
    title: "Expense notes",
    minutes: 30,
    due: `${addDays(W, 3)}T17:00`,
    level: 2,
  });
  const listTasks = { tools: [{ name: "list_tasks", arguments: {} }] };
  const task = (req: ChatRequest, title: string) => {
    const t = toolJson<Tasks>(req, "list_tasks").tasks.find((x) => x.title === title);
    if (!t) throw new Error(`no ${title} in list_tasks`);
    return t;
  };
  let breakSlot: { start: string; end: string } | undefined;

  llm.on(matches(prompt("Back-plan work from due dates")), [
    listTasks,
    (req) => {
      const t = task(req, "Quarterly report");
      return {
        tools: [
          {
            name: "propose_create_event",
            arguments: {
              title: "Work time: Quarterly report",
              start: iso(at(addDays(W, 3), "14:00")),
              end: iso(at(addDays(W, 3), "16:00")),
              reason: `Due ${t.due}`,
            },
          },
        ],
      };
    },
    { content: "I staged work time before the due date. It waits for your approval." },
  ]);
  llm.on(matches(prompt("What to do now")), [
    listTasks,
    (req) => {
      const [first] = toolJson<Tasks>(req, "list_tasks").tasks;
      return { content: `Start ${first?.title}: it is due first.` };
    },
  ]);
  llm.on(matches(prompt("Plan my day")), [
    {
      tools: [
        {
          name: "find_meeting_time",
          arguments: {
            duration_minutes: 15,
            start: iso(at(W, "12:00")),
            end: iso(at(W, "17:00")),
          },
        },
      ],
    },
    (req) => {
      breakSlot = toolJson<Slots>(req, "find_meeting_time").slots[0];
      if (!breakSlot) throw new Error("no free slot");
      return {
        tools: [
          {
            name: "propose_create_event",
            arguments: { title: "Short break", start: breakSlot.start, end: breakSlot.end },
          },
        ],
      };
    },
    { content: "I staged a short break. It waits for your approval." },
  ]);
  llm.on(matches(prompt("Task re-ranking")), [
    listTasks,
    // A lower priority first: applying it touches every open task of the user,
    // and the two changes after it must still apply.
    (req) => ({
      tools: (
        [
          ["Budget review", 4, "It is small."],
          ["Quarterly report", 1, "It has the most work left."],
          ["Expense notes", 3, "It can wait."],
        ] as const
      ).map(([title, priority, reason]) => ({
        name: "propose_task_priority",
        arguments: { task_id: task(req, title).id, priority, reason },
      })),
    }),
    { content: "I staged new priorities. They wait for your approval." },
  ]);

  for (const name of [
    "Back-plan work from due dates",
    "What to do now",
    "Plan my day",
    "Task re-ranking",
  ]) {
    await openEntry(page, name);
    await sendDraft(page);
  }
  await expect(proposal(page, "Work time: Quarterly report")).toContainText(
    "Waiting for your approval",
  );
  await expect(proposal(page, "Short break")).toContainText("Waiting for your approval");
  for (const s of RANKS) await expect(proposal(page, s)).toContainText("Waiting for your approval");
  await expect(chatPanel(page).getByTestId("chat-assistant")).toContainText([
    "I staged work time before the due date.",
    "Start Budget review: it is due first.",
    "I staged a short break.",
    "I staged new priorities.",
  ]);

  // What the app sent: the prompt, the planner dates shown, the tools, and the real tasks.
  const monday = shownMonday();
  for (const name of ["Back-plan work from due dates", "What to do now", "Plan my day"]) {
    expect(plannerDates(turnOf(llm, prompt(name)))).toEqual({
      from: monday,
      to: addDays(monday, 7),
    });
  }
  const rerank = turnOf(llm, prompt("Task re-ranking"));
  expect(toolNames(rerank)).toEqual(
    expect.arrayContaining(["list_tasks", "find_meeting_time", "propose_task_priority"]),
  );
  const listed = llm.requests.find((r) => r.messages.some((m) => m.role === "tool"));
  expect(
    toolJson<Tasks>(listed as ChatRequest, "list_tasks").tasks.map((t) => [t.title, t.priority]),
  ).toEqual([
    ["Budget review", 3],
    ["Expense notes", 2],
    ["Quarterly report", 2],
  ]);

  // Rule 12: nothing changed before approval.
  await planNow(page);
  const before = await weekOf(cal, W);
  expect(named(before, "Work time: Quarterly report")).toHaveLength(0);
  expect(named(before, "Short break")).toHaveLength(0);
  await page.getByRole("link", { name: "Tasks" }).click();
  await expectLevels(page, ["P3 medium", "P2 high", "P2 high"]);

  // After reload, the chat still shows the five proposals; the user accepts and applies.
  await page.goto("/");
  await expect(previewPanel(page).getByTestId("staged-change")).toHaveCount(5);
  await openAssistant(page);
  for (const s of ["Work time: Quarterly report", "Short break", ...RANKS]) {
    await proposal(page, s).getByRole("button", { name: "Accept" }).click();
    await expect(proposal(page, s)).toContainText("Accepted");
  }
  await chatPanel(page).getByRole("button", { name: "Close" }).click();
  await reviewAndApply(page);
  await expect(page.getByTestId("apply-summary")).toContainText(
    "Applied 5 · Skipped as stale 0 · Failed 0",
  );
  const after = await eventually(
    () => weekOf(cal, W),
    (evs) => expect(named(evs, "Short break")).toHaveLength(1),
  );
  expect(
    named(after, "Work time: Quarterly report").map((e) => [local(e.start), local(e.end)]),
  ).toEqual([[`${addDays(W, 3)} 14:00`, `${addDays(W, 3)} 16:00`]]);
  const slot = breakSlot as { start: string; end: string };
  expect(named(after, "Short break").map((e) => [e.start, e.end])).toEqual([
    [Date.parse(slot.start), Date.parse(slot.end)],
  ]);
  await page.getByRole("link", { name: "Tasks" }).click();
  await page.reload();
  await expectLevels(page, ["P4 low", "P3 medium", "P1 critical"]);
});

test("meeting prompts reach the model as the user edited them, with the dates in view; onboarding meetings, a cross-team meeting, an urgent review that moves a lower-priority task, and a conflict fix wait in preview mode until applied (library entries 12, 15, 18, 21; assistant-chat rules 5, 6, 12)", async ({
  page,
  cal,
  signIn,
  llm,
}) => {
  const tue = addDays(W, 1);
  await blockUntil(cal, W);
  await cal.addEvent({
    title: "Vendor call",
    start: at(tue, "10:00"),
    end: at(tue, "11:00"),
    attendees: ["vendor@example.com"],
  });
  await cal.addEvent({ title: "Team sync", start: at(tue, "10:30"), end: at(tue, "11:30") });
  await signIn();
  // A P4 task that Tempoloom plans on Thursday: the urgent review may move it (entry 18).
  const thu = addDays(W, 3);
  await addTask(page, {
    title: "Inbox cleanup",
    minutes: 60,
    split: false,
    level: 4,
    startAfter: `${thu}T00:00`,
    due: `${addDays(W, 4)}T17:00`,
  });
  const planned = await eventually(
    () => weekOf(cal, W),
    (evs) => expect(titled(evs, "Inbox cleanup")).toHaveLength(1),
  );
  const inboxAt = local((titled(planned, "Inbox cleanup")[0] as { start: number }).start);
  expect(inboxAt.startsWith(thu)).toBe(true);

  const customer = "ana@client.example";
  const colleagues = ["li@partner.example", "bo@partner.example"];
  const onboarding = prompt("Customer onboarding meeting plan").replace(
    "this customer",
    `this customer (${customer})`,
  );
  const crossTeam = prompt("Cross-team meeting time").replace("…", colleagues.join(", "));
  const urgent = prompt("Urgent review meeting").replace(
    "these people.",
    `these people: ${colleagues[0]}.`,
  );
  const findSlot = (attendees: string[], from = addDays(W, 2)) => ({
    tools: [
      {
        name: "find_meeting_time",
        arguments: {
          duration_minutes: 30,
          attendees,
          start: iso(at(from, "00:00")),
          end: iso(at(addDays(W, 5), "00:00")),
        },
      },
    ],
  });
  const slots: Record<string, { start: string; end: string }> = {};
  const meetAt = (title: string, attendees: string[]) => (req: ChatRequest) => {
    const r = toolJson<Slots>(req, "find_meeting_time");
    const s = r.slots[0];
    if (!s) throw new Error("no free slot");
    slots[title] = s;
    return {
      tools: [
        {
          name: "propose_create_event",
          arguments: { title, start: s.start, end: s.end, attendees },
        },
      ],
      content: `Their calendars are not on this server: ${r.unknown_attendees.join(", ")}.`,
    };
  };

  llm.on(matches(onboarding), [
    {
      tools: [
        ["Onboarding kickoff", 2, "10:00", "11:00"],
        ["Onboarding check-in", 9, "10:00", "10:30"],
        ["Onboarding review", 32, "10:00", "10:30"],
      ].map(([title, d, from, to]) => ({
        name: "propose_create_event",
        arguments: {
          title,
          start: iso(at(addDays(W, d as number), from as string)),
          end: iso(at(addDays(W, d as number), to as string)),
          attendees: [customer],
        },
      })),
    },
    { content: "I staged the three onboarding meetings. They wait for your approval." },
  ]);
  llm.on(matches(crossTeam), [
    findSlot(colleagues),
    meetAt("Cross-team meeting", colleagues),
    { content: "I staged the meeting. It waits for your approval." },
  ]);
  // Entry 18: the earliest slot from Thursday, and the user's P4 task there moves away.
  llm.on(matches(urgent), [
    findSlot([colleagues[0] as string], thu),
    {
      tools: [
        {
          name: "list_events",
          arguments: { start: iso(at(thu, "00:00")), end: iso(at(addDays(thu, 1), "00:00")) },
        },
      ],
    },
    (req) => {
      const inbox = toolJson<Listed>(req, "list_events").events.find((e) =>
        e.title.includes("Inbox cleanup"),
      );
      if (!inbox) throw new Error("no Inbox cleanup in list_events");
      const made = meetAt("Urgent review", [colleagues[0] as string])(req);
      return {
        ...made,
        tools: [
          {
            name: "propose_update_event",
            arguments: {
              event_id: inbox.id,
              start: iso(at(thu, "15:00")),
              reason: "It is P4 and in the way.",
            },
          },
          ...made.tools,
        ],
      };
    },
    { content: "I staged the review and moved Inbox cleanup. They wait for your approval." },
  ]);
  // Entry 21: the model reads the dates the app said are in view.
  llm.on(matches(prompt("Conflict fixes")), [
    (req) => {
      const { from, to } = plannerDates(req);
      return {
        tools: [
          {
            name: "list_events",
            arguments: { start: iso(at(from, "00:00")), end: iso(at(to, "00:00")) },
          },
        ],
      };
    },
    (req) => {
      const sync = toolJson<Listed>(req, "list_events").events.find((e) => e.title === "Team sync");
      if (!sync) return { content: "No conflicts in the dates shown." };
      return {
        tools: [
          {
            name: "propose_update_event",
            arguments: {
              event_id: sync.id,
              start: iso(at(tue, "12:00")),
              end: iso(at(tue, "13:00")),
              reason: "It overlaps Vendor call.",
            },
          },
        ],
      };
    },
    { content: "Team sync overlaps Vendor call; I staged a move. It waits for your approval." },
  ]);

  // The user edits each prompt before sending (rule 7).
  for (const [name, text] of [
    ["Customer onboarding meeting plan", onboarding],
    ["Cross-team meeting time", crossTeam],
    ["Urgent review meeting", urgent],
  ] as const) {
    const box = await openEntry(page, name);
    await box.fill(text);
    expect(await sendDraft(page)).toBe(text);
  }
  // Entry 21 covers the dates in view: the user moves the planner to the test week first.
  await openEntry(page, "Conflict fixes");
  for (let n = diffDays(shownMonday(), W) / 7; n > 0; n--) {
    const label = await page.getByTestId("week-label").textContent();
    await page.getByRole("button", { name: "Next week" }).click();
    await expect(page.getByTestId("week-label")).not.toHaveText(label ?? "");
  }
  await expect(chatPanel(page).getByLabel("Message to the assistant")).toHaveValue(
    prompt("Conflict fixes"),
  );
  await sendDraft(page);

  // What the app sent: the edited texts, the dates in view, the real calendar.
  expect(turnOf(llm, onboarding)).toBeDefined();
  const conflict = turnOf(llm, prompt("Conflict fixes"));
  expect(plannerDates(conflict)).toEqual({ from: W, to: addDays(W, 7) });
  expect(plannerDates(turnOf(llm, crossTeam)).from).toBe(shownMonday());
  // The conflict turn read the week in view from the calendar.
  const read = llm.requests.find(
    (r) => lastUser(r) === prompt("Conflict fixes") && toolResults(r).length > 0,
  );
  expect(
    toolJson<Listed>(read as ChatRequest, "list_events")
      .events.map((e) => e.title)
      .sort(),
  ).toEqual(expect.arrayContaining(["Team sync", "Vendor call"]));
  await expect(chatPanel(page).getByTestId("chat-assistant")).toContainText([
    "I staged the three onboarding meetings.",
    `Their calendars are not on this server: ${colleagues.join(", ")}.`,
    "I staged the meeting.",
    `Their calendars are not on this server: ${colleagues[0]}.`,
    "I staged the review and moved Inbox cleanup.",
    "Team sync overlaps Vendor call; I staged a move.",
  ]);
  await expect(chatPanel(page).getByTestId("chat-proposal")).toHaveCount(7);
  await expect(proposal(page, "Move “Inbox cleanup”")).toContainText("Waiting for your approval");

  // Rule 12: nothing reached the calendar.
  await planNow(page);
  const before = await weekOf(cal, W);
  expect(before.filter((e) => /Onboarding|Cross-team|Urgent/.test(e.summary))).toEqual([]);
  expect(named(before, "Team sync").map((e) => local(e.start))).toEqual([`${tue} 10:30`]);
  expect(titled(before, "Inbox cleanup").map((e) => local(e.start))).toEqual([inboxAt]);

  await page.reload();
  await expect(previewPanel(page).getByTestId("staged-change")).toHaveCount(7);
  await openAssistant(page);
  const cards = chatPanel(page).getByTestId("chat-proposal");
  for (let i = 0; i < 7; i++) {
    await cards.nth(i).getByRole("button", { name: "Accept" }).click();
    await expect(cards.nth(i)).toContainText("Accepted");
  }
  await chatPanel(page).getByRole("button", { name: "Close" }).click();
  await reviewAndApply(page);
  await expect(page.getByTestId("apply-summary")).toContainText(
    "Applied 7 · Skipped as stale 0 · Failed 0",
  );

  const after = await eventually(
    () => cal.events(at(W, "00:00"), at(addDays(W, 40), "00:00")),
    (evs) => expect(named(evs, "Onboarding review")).toHaveLength(1),
  );
  expect(named(after, "Team sync").map((e) => [local(e.start), local(e.end)])).toEqual([
    [`${tue} 12:00`, `${tue} 13:00`],
  ]);
  expect(titled(after, "Inbox cleanup").map((e) => [local(e.start), local(e.end)])).toEqual([
    [`${thu} 15:00`, `${thu} 16:00`],
  ]);
  expect(
    ["Onboarding kickoff", "Onboarding check-in", "Onboarding review"].map((t) =>
      named(after, t).map((e) => local(e.start)),
    ),
  ).toEqual([[`${addDays(W, 2)} 10:00`], [`${addDays(W, 9)} 10:00`], [`${addDays(W, 32)} 10:00`]]);
  for (const [title, people] of [
    ["Onboarding kickoff", [customer]],
    ["Cross-team meeting", colleagues],
    ["Urgent review", [colleagues[0] as string]],
  ] as const) {
    const [ev] = named(after, title);
    if (!ev) throw new Error(`no ${title}`);
    const slot = slots[title];
    if (slot) expect([ev.start, ev.end]).toEqual([Date.parse(slot.start), Date.parse(slot.end)]);
    expect((await cal.guests(ev.id)).map((g) => g.email).sort()).toEqual(
      expect.arrayContaining([...people].sort()),
    );
  }
});

test("rhythm and burnout prompts reach the model with the user's stats of the last 4 weeks, read from the calendar (library entries 14, 16; assistant-chat rule 9)", async ({
  page,
  cal,
  app,
  signIn,
  llm,
}) => {
  const P = lastWeek();
  await meet(cal, P, "10:00", "12:00", "Design workshop", ["dee@example.com"]);
  await meet(cal, addDays(P, 1), "19:00", "20:00", "Late call", ["dee@example.com"]);
  await signIn();
  await synced(app, [EMAIL]);
  const today = utcToLocal(ZONE, Date.now()).date;
  const stats = {
    tools: [{ name: "get_stats", arguments: { start_date: addDays(today, -28), end_date: today } }],
  };
  interface Stats {
    highlights: { meetingMinutes: number; meetingMinutesOutsideWorkHours: number };
  }
  llm.on(matches(prompt("Work rhythm review")), [
    stats,
    (req) => ({
      content: `You met ${toolJson<Stats>(req, "get_stats").highlights.meetingMinutes} min in 4 weeks.`,
    }),
  ]);
  llm.on(matches(prompt("Burnout risk review")), [
    stats,
    (req) => ({
      content: `${toolJson<Stats>(req, "get_stats").highlights.meetingMinutesOutsideWorkHours} min of meetings were outside work hours.`,
    }),
  ]);

  await openEntry(page, "Work rhythm review");
  await sendDraft(page);
  await expect(reply(page)).toHaveText("You met 180 min in 4 weeks.");
  await openEntry(page, "Burnout risk review");
  await sendDraft(page);
  await expect(reply(page)).toHaveText("60 min of meetings were outside work hours.");
  for (const name of ["Work rhythm review", "Burnout risk review"]) {
    const req = turnOf(llm, prompt(name));
    expect(toolNames(req)).toContain("get_stats");
    expect(plannerDates(req).from).toBe(shownMonday());
  }

  await page.reload();
  await openAssistant(page);
  await expect(chatPanel(page).getByTestId("chat-user")).toHaveText([
    prompt("Work rhythm review"),
    prompt("Burnout risk review"),
  ]);
  await expect(reply(page)).toHaveText("60 min of meetings were outside work hours.");
});

test("the team health prompt reads team stats as the team stats page shows them: no values below 3 members, then means over the members and no names (library entry 17; team stats rules 1, edge case 1)", async ({
  page,
  app,
  cal,
  signIn,
  colleague,
  people,
  llm,
}) => {
  const P = lastWeek();
  const c = await people(3);
  const B = colleague.email;
  const C = c.email;
  // A: a team meeting and a 3 h one-on-one with B. B: the same. C: the team meeting.
  await meet(cal, P, "10:00", "11:00", "Team planning", [B, C]);
  await meet(cal, addDays(P, 1), "10:00", "13:00", "Pairing", [B]);
  await meet(colleague.cal, P, "10:00", "11:00", "Team planning", [EMAIL, C]);
  await meet(colleague.cal, addDays(P, 1), "10:00", "13:00", "Pairing", [EMAIL]);
  await meet(c.cal, P, "10:00", "11:00", "Team planning", [EMAIL, B]);
  await signIn();
  await colleague.signIn();
  const idp = await directory(page);
  await idp.create({ userName: EMAIL });
  await idp.create({ userName: B });
  await page.goto("/");

  interface TeamStats {
    enough: boolean;
    members_included: number;
    minutes_per_week: Record<string, number> | null;
  }
  const text = prompt("Team meeting health review");
  llm.on(matches(text), [
    { tools: [{ name: "get_team_stats", arguments: { start_date: P, end_date: addDays(P, 6) } }] },
    (req) => {
      const s = toolJson<TeamStats>(req, "get_team_stats");
      return {
        content: s.enough
          ? `One-on-ones: ${s.minutes_per_week?.oneOnOne} min, team meetings: ${s.minutes_per_week?.teamMeetings} min per person per week.`
          : `Not enough members for team stats (${s.members_included}).`,
      };
    },
  ]);

  await openEntry(page, "Team meeting health review");
  await sendDraft(page);
  await expect(reply(page)).toHaveText("Not enough members for team stats (2).");
  expect(toolNames(turnOf(llm, text))).toContain("get_team_stats");

  await c.signIn();
  await idp.create({ userName: C });
  await synced(app, [EMAIL, B, C]);
  await openEntry(page, "Team meeting health review");
  await sendDraft(page);
  await expect(reply(page)).toHaveText(
    "One-on-ones: 120 min, team meetings: 60 min per person per week.",
  );
  // The model gets means, never a member's name, email or event title.
  const last = llm.requests.at(-1) as ChatRequest;
  const result = JSON.stringify(toolJson<TeamStats>(last, "get_team_stats"));
  for (const secret of [B, C, "Pairing", "Team planning"]) expect(result).not.toContain(secret);
  await page.reload();
  await openAssistant(page);
  await expect(reply(page)).toHaveText(
    "One-on-ones: 120 min, team meetings: 60 min per person per week.",
  );
});

test("adaptive workday and prep task prompts read today's planned items and the next 7 days of meetings; a move of a planned item waits in preview mode until applied (library entries 20, 31; assistant-chat rules 6, 8, 12)", async ({
  page,
  app,
  cal,
  signIn,
  llm,
}) => {
  // The server's today is Monday of the test week, 07:00.
  await serverClockAt(app, at(W, "07:00"));
  await blockUntil(cal, W);
  await cal.addEvent({
    title: "Board meeting",
    start: at(addDays(W, 2), "10:00"),
    end: at(addDays(W, 2), "11:00"),
    attendees: ["chair@example.com"],
  });
  await signIn();
  await addTask(page, {
    title: "Write spec",
    minutes: 60,
    split: false,
    due: `${W}T17:00`,
  });
  const planned = await eventually(
    () => weekOf(cal, W),
    (evs) => expect(titled(evs, "Write spec")).toHaveLength(1),
  );
  const [spec] = titled(planned, "Write spec");
  if (!spec) throw new Error("no planned task");
  expect(local(spec.start) < `${W} 12:00`).toBe(true);

  const adaptive = prompt("Adaptive workday").replace("from … to …", "from 13:00 to 18:00");
  llm.on(matches(adaptive), [
    {
      tools: [
        {
          name: "list_events",
          arguments: { start: iso(at(W, "00:00")), end: iso(at(addDays(W, 1), "00:00")) },
        },
      ],
    },
    (req) => {
      const e = toolJson<Listed>(req, "list_events").events.find((x) =>
        x.title.includes("Write spec"),
      );
      if (!e) throw new Error("no Write spec in list_events");
      return {
        tools: [
          {
            name: "propose_update_event",
            arguments: { event_id: e.id, start: iso(at(W, "13:00")) },
          },
        ],
      };
    },
    { content: "I staged Write spec at 13:00. It waits for your approval." },
  ]);
  llm.on(matches(prompt("Prep task suggestions")), [
    {
      tools: [
        {
          name: "list_events",
          arguments: { start: iso(at(W, "07:00")), end: iso(at(addDays(W, 7), "07:00")) },
        },
      ],
    },
    (req) => ({
      content: toolJson<Listed>(req, "list_events")
        .events.filter((e) => e.title === "Board meeting")
        .map((e) => `Prep for ${e.title}, due ${local(Date.parse(e.start) - 86_400_000)}.`)
        .join(" "),
    }),
  ]);

  const box = await openEntry(page, "Adaptive workday");
  await box.fill(adaptive);
  await sendDraft(page);
  await expect(proposal(page, "Write spec")).toContainText("Waiting for your approval");
  await openEntry(page, "Prep task suggestions");
  await sendDraft(page);
  await expect(reply(page)).toHaveText(`Prep for Board meeting, due ${addDays(W, 1)} 10:00.`);
  // The model's "today" is the server's: Monday of the test week.
  expect(systemOf(turnOf(llm, adaptive))).toContain(`Now: Monday ${W}T07:00`);

  // Rule 12: the planned item stays until the user applies.
  await planNow(page);
  const before = await weekOf(cal, W);
  expect(titled(before, "Write spec").map((e) => local(e.start))).toEqual([local(spec.start)]);
  await page.reload();
  await openAssistant(page);
  await proposal(page, "Write spec").getByRole("button", { name: "Accept" }).click();
  await expect(proposal(page, "Write spec")).toContainText("Accepted");
  await chatPanel(page).getByRole("button", { name: "Close" }).click();
  await reviewAndApply(page);
  await expect(page.getByTestId("apply-summary")).toContainText(
    "Applied 1 · Skipped as stale 0 · Failed 0",
  );
  await eventually(
    () => weekOf(cal, W),
    (evs) =>
      expect(titled(evs, "Write spec").map((e) => [local(e.start), local(e.end)])).toEqual([
        [`${W} 13:00`, `${W} 14:00`],
      ]),
  );
});
