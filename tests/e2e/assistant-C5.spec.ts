// People and meetings by chat (docs/specs/assistant-chat.md rules 5, 25, 26;
// edge cases 1, 2, 6; plans-feature-inventory.md chat limits), with the fake
// model (tests/e2e/fake-llm.ts). Each test checks what the app sent to the
// model (tool results, system prompt) and what the app did with the calls,
// against the real CalDAV server. The last test needs a real model.
//
// Ways this can fail, each covered below:
// - find time ignores a colleague's busy events or meeting hours, or reads the
//   calendar of a person outside the team (edge case 6);
// - the event with the colleague is written or announced before approval;
// - no slot fits and the model gets nothing to offer (edge case 2);
// - two colleagues match a name and a change is staged anyway (edge case 1),
//   or a person outside the team is listed;
// - a role in a memory does not resolve through the directory's reporting
//   tree, or resolves without one (rule 26);
// - an agenda reaches the event before approval, or not after;
// - a memory passes the instance limit, by the model or by Save.
import type { Page } from "@playwright/test";
import { addDays } from "../../src/shared/time.ts";
import { chatPanel, openAssistant, proposal, say } from "./assistant-helpers.ts";
import { type ChatRequest, toolJson, toolResults } from "./fake-llm.ts";
import {
  at,
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
import { addTask, W } from "./helpers.ts";
import { iso, previewPanel, reviewAndApply } from "./preview-helpers.ts";
import { scim } from "./scim.ts";
import { openTeam, teamOfTwo } from "./team-helpers.ts";

const tue = addDays(W, 1);
const thu = addDays(W, 3);
const weekEvents = (cal: CalendarDriver) => cal.events(at(W, "00:00"), at(addDays(W, 7), "00:00"));
const named = <T extends { summary: string }>(evs: T[], title: string) =>
  evs.filter((e) => e.summary === title);
const systemOf = (req: ChatRequest | undefined) =>
  req?.messages.find((m) => m.role === "system")?.content ?? "";
const tuesday = { start: iso(at(tue, "00:00")), end: iso(at(addDays(tue, 1), "00:00")) };

interface Free {
  slots: { start: string; end: string }[];
  unknown_attendees: string[];
  deactivated_attendees: string[];
  closest?: { start: string; end: string; unavailable: string[] }[];
  wider_range?: { start: string; end: string }[];
}

/** The colleague's meeting hours start at `from` on weekdays (Settings page). */
async function meetingHoursFrom(p: Page, from: string) {
  await p.getByRole("link", { name: "Settings" }).click();
  for (const d of [1, 2, 3, 4, 5])
    await p.getByTestId(`range-meeting-${d}-0`).locator("input").first().fill(from);
  await p.getByRole("button", { name: "Save meeting hours" }).click();
  await expect(p.getByTestId("settings-message")).toHaveText("Saved");
}

test("find time with a colleague uses their busy events and meeting hours, reads nobody outside the team, and invites only after approval (assistant-chat rule 5; edge case 6; T3)", async ({
  page,
  cal,
  signIn,
  colleague,
  people,
  mail,
  llm,
}) => {
  // U: lunch 14:00-14:30. V (team): busy 13:00-14:00, meeting hours from 13:00.
  // Ben (own team on this server): busy 14:30-16:30, so a read of his calendar moves the slot.
  await cal.addEvent({ title: "Lunch", start: at(tue, "14:00"), end: at(tue, "14:30") });
  await colleague.cal.addEvent({
    title: "V busy",
    start: at(tue, "13:00"),
    end: at(tue, "14:00"),
  });
  const ben = await people(3);
  await ben.cal.addEvent({ title: "Ben busy", start: at(tue, "14:30"), end: at(tue, "16:30") });
  await ben.signIn();
  const pv = await teamOfTwo(page, signIn, colleague, mail);
  await meetingHoursFrom(pv, "13:00");

  const guests = [COLLEAGUE_EMAIL, ben.email];
  llm.on(/find 30 minutes/i, [
    {
      tools: [
        {
          name: "find_meeting_time",
          arguments: { duration_minutes: 30, ...tuesday, attendees: guests },
        },
      ],
    },
    (req) => {
      const [slot] = toolJson<Free>(req, "find_meeting_time").slots;
      return {
        tools: [
          {
            name: "propose_create_event",
            arguments: { title: "Project sync", ...slot, attendees: guests },
          },
        ],
      };
    },
    (req) => ({
      content: `I staged Project sync. I cannot read the calendar of ${toolJson<Free>(req, "find_meeting_time").unknown_attendees.join(", ")}, so the time uses your side only.`,
    }),
  ]);

  await page.goto(`/?week=${W}`);
  await openAssistant(page);
  expect(await say(page, "Find 30 minutes with my colleague and Ben on Tuesday")).toBe(200);
  const first = llm.requests.find((r) =>
    toolResults(r).some((t) => t.name === "find_meeting_time"),
  );
  const free = toolJson<Free>(first as ChatRequest, "find_meeting_time");
  // After U's lunch and V's busy hour, inside V's meeting hours; Ben's calendar is not read.
  expect(local(Date.parse(free.slots[0]?.start ?? ""))).toBe(`${tue} 14:30`);
  expect(free.unknown_attendees).toEqual([ben.email]);
  expect(systemOf(first)).toContain("Tempoloom meeting hours");
  await expect(chatPanel(page).getByTestId("chat-assistant").last()).toContainText(
    `I cannot read the calendar of ${ben.email}`,
  );
  const card = proposal(page, "Project sync");
  await expect(card).toContainText("14:30");
  await expect(card).toContainText(`invites ${COLLEAGUE_EMAIL}, ${ben.email}`);
  await expect(card).toContainText("Waiting for your approval");

  // Nothing is written and nobody is invited before approval.
  await planNow(page);
  expect(named(await weekEvents(cal), "Project sync")).toHaveLength(0);
  expect(await mail.count(COLLEAGUE_EMAIL, /Invitation: Project sync/)).toBe(0);

  await page.reload();
  await openAssistant(page);
  await proposal(page, "Project sync").getByRole("button", { name: "Accept" }).click();
  await expect(proposal(page, "Project sync")).toContainText("Accepted");
  await chatPanel(page).getByRole("button", { name: "Close" }).click();
  await reviewAndApply(page);
  await expect(page.getByTestId("apply-summary")).toContainText("Applied 1");
  const [made] = await eventually(
    async () => named(await weekEvents(cal), "Project sync"),
    (l) => expect(l).toHaveLength(1),
  );
  expect([local(made?.start ?? 0), local(made?.end ?? 0)]).toEqual([
    `${tue} 14:30`,
    `${tue} 15:00`,
  ]);
  expect((await cal.guests(made?.id ?? "")).map((g) => g.email).sort()).toEqual([...guests].sort());
  await mail.message(COLLEAGUE_EMAIL, /Invitation: Project sync/);
  await page.reload();
  await expect(previewPanel(page).getByTestId("staged-change")).toHaveCount(0);
  expect(named(await weekEvents(cal), "Project sync")).toHaveLength(1);
});

test("when no slot fits, the model gets the closest options and a wider range and stages nothing (assistant-chat edge case 2)", async ({
  page,
  signIn,
  colleague,
  mail,
  llm,
}) => {
  // V is busy for all of Tuesday's meeting hours.
  await colleague.cal.addEvent({
    title: "V offsite",
    start: at(tue, "08:00"),
    end: at(tue, "18:00"),
  });
  await teamOfTwo(page, signIn, colleague, mail);
  llm.on(/an hour with my colleague/i, [
    {
      tools: [
        {
          name: "find_meeting_time",
          arguments: { duration_minutes: 60, ...tuesday, attendees: [COLLEAGUE_EMAIL] },
        },
      ],
    },
    (req) => {
      const r = toolJson<Free>(req, "find_meeting_time");
      const t = (s: string) => local(Date.parse(s));
      return {
        content: `No hour fits on Tuesday. Closest: ${t(r.closest?.[0]?.start ?? "")} without ${r.closest?.[0]?.unavailable.join(", ")}. Wider range: ${t(r.wider_range?.[0]?.start ?? "")}.`,
      };
    },
  ]);
  await page.goto(`/?week=${W}`);
  await openAssistant(page);
  expect(await say(page, "Find an hour with my colleague on Tuesday")).toBe(200);
  const r = toolJson<Free>(llm.requests.at(-1) as ChatRequest, "find_meeting_time");
  expect(r.slots).toEqual([]);
  expect(r.closest?.[0]).toMatchObject({ unavailable: [COLLEAGUE_EMAIL] });
  expect(local(Date.parse(r.closest?.[0]?.start ?? ""))).toBe(`${tue} 09:00`);
  expect(local(Date.parse(r.wider_range?.[0]?.start ?? ""))).toBe(`${addDays(tue, 1)} 09:00`);
  const answer = `No hour fits on Tuesday. Closest: ${tue} 09:00 without ${COLLEAGUE_EMAIL}. Wider range: ${addDays(tue, 1)} 09:00.`;
  await expect(chatPanel(page).getByTestId("chat-assistant").last()).toHaveText(answer);
  await expect(chatPanel(page).getByTestId("chat-proposal")).toHaveCount(0);
  await page.reload();
  await expect(previewPanel(page).getByTestId("staged-change")).toHaveCount(0);
  await openAssistant(page);
  await expect(chatPanel(page).getByTestId("chat-assistant").last()).toHaveText(answer);
});

test("two colleagues with the same name make the assistant ask instead of staging; a role in a memory resolves through the directory's reporting tree, and without one the assistant asks (assistant-chat rules 25, 26; edge case 1)", async ({
  page,
  signIn,
  colleague,
  people,
  llm,
}) => {
  // A person outside the team whose email also matches.
  const outsider = await people(3, "alex.out@tempoloom.test");
  await outsider.signIn();
  await signIn();
  await openTeam(page);
  const directory = page.getByTestId("directory");
  await directory.getByRole("button", { name: "Create SCIM token" }).click();
  const idp = scim((await directory.getByTestId("scim-token").textContent()) ?? "");
  const maraId = await idp.create({
    userName: "mara.costa@tempoloom.test",
    displayName: "Mara Costa",
  });
  const meId = await idp.create({ userName: EMAIL, managerId: maraId });
  await idp.create({
    userName: "rui.dias@tempoloom.test",
    displayName: "Rui Dias",
    managerId: meId,
  });
  await idp.create({ userName: "alex.lima@tempoloom.test", displayName: "Alex Lima" });
  await idp.create({ userName: "alex.moreno@tempoloom.test", displayName: "Alex Moreno" });

  llm.on(/30 minutes with alex/i, [
    { tools: [{ name: "find_people", arguments: { query: "Alex" } }] },
    { content: "Which Alex?" },
  ]);
  // A model that resolves a role only from the reporting line the app gives it.
  llm.on(/from my manager/i, [
    (req) => {
      const m = /"manager": \{\s*"name": "([^"]+)",\s*"email": "([^"]+)"/.exec(systemOf(req));
      return m
        ? {
            tools: [
              {
                name: "save_memory",
                arguments: {
                  text: `Accept invitations from my manager ${m[1]} (${m[2]})`,
                  people: [m[2]],
                },
              },
            ],
          }
        : { content: "Who is your manager? Please give a name or an email." };
    },
    { content: "The memory waits for your approval." },
  ]);

  await page.goto(`/?week=${W}`);
  await openAssistant(page);
  expect(await say(page, "Find 30 minutes with Alex tomorrow")).toBe(200);
  // The app gave the model both team members (not the outsider), the instruction
  // to ask in the tool result, and the same rule in the system prompt.
  const asked = llm.requests.at(-1) as ChatRequest;
  const found = toolJson<{ people: { name: string; email: string }[]; note?: string }>(
    asked,
    "find_people",
  );
  expect(found.people).toEqual([
    { name: "Alex Lima", email: "alex.lima@tempoloom.test" },
    { name: "Alex Moreno", email: "alex.moreno@tempoloom.test" },
  ]);
  expect(found.note).toContain("Ask the user which one they mean, and stage nothing");
  expect(systemOf(asked)).toContain(
    "when more than one person matches, ask which one and stage nothing",
  );
  // Nothing was staged: not in the chat, not in preview mode, also after a reload.
  await expect(chatPanel(page).getByTestId("chat-proposal")).toHaveCount(0);
  await page.reload();
  await expect(previewPanel(page).getByTestId("staged-change")).toHaveCount(0);
  await openAssistant(page);

  // Rule 26 with the reporting tree: the model gets the manager and the reports.
  expect(await say(page, "Remember: accept invitations from my manager")).toBe(200);
  const system = systemOf(llm.requests.at(-1));
  expect(system).toContain('"email": "mara.costa@tempoloom.test"');
  expect(system).toContain('"email": "rui.dias@tempoloom.test"');
  const text = "Accept invitations from my manager Mara Costa (mara.costa@tempoloom.test)";
  const card = chatPanel(page).getByTestId("chat-memory");
  await expect(card).toContainText(`Remember: ${text}`);
  const saved = page.waitForResponse(
    (r) =>
      /\/api\/assistant\/memories\/[^/]+\/save$/.test(r.url()) && r.request().method() === "POST",
  );
  await card.getByRole("button", { name: "Save memory" }).click();
  expect((await saved).status()).toBe(200);
  await page.reload();
  await openAssistant(page);
  await chatPanel(page).getByRole("button", { name: "Memories" }).click();
  await expect(chatPanel(page).getByTestId("memory")).toHaveCount(1);
  await expect(chatPanel(page).getByTestId("memory")).toContainText(text);
  await page.reload();
  await expect(previewPanel(page).getByTestId("staged-change")).toHaveCount(0);

  // Without directory data, the same request gets a question and no memory.
  const pb = await colleague.signIn(`/?week=${W}`);
  await openAssistant(pb);
  expect(await say(pb, "Remember: accept invitations from my manager")).toBe(200);
  const plain = systemOf(llm.requests.at(-1));
  expect(plain).not.toContain('"reporting"');
  expect(plain).toContain("There is no reporting line from the directory");
  await expect(chatPanel(pb).getByTestId("chat-assistant").last()).toHaveText(
    "Who is your manager? Please give a name or an email.",
  );
  await expect(chatPanel(pb).getByTestId("chat-memory")).toHaveCount(0);
  await pb.reload();
  await openAssistant(pb);
  await chatPanel(pb).getByRole("button", { name: "Memories" }).click();
  await expect(chatPanel(pb).getByTestId("memory")).toHaveCount(0);
});

test("an agenda and prep plan from the meeting context go into the event's description only after approval (assistant-chat; agendas and prep plans)", async ({
  page,
  cal,
  signIn,
  mail,
  llm,
}) => {
  const hour = 3_600_000;
  const past = Math.floor(Date.now() / hour) * hour - 48 * hour;
  await cal.addEvent({
    title: "Kickoff",
    start: past,
    end: past + hour,
    attendees: [COLLEAGUE_EMAIL],
  });
  await cal.addEvent({
    title: "Weekly sync",
    start: at(thu, "10:00"),
    end: at(thu, "10:30"),
    attendees: [COLLEAGUE_EMAIL],
    description: "Room 4",
  });
  await signIn();
  await addTask(page, { title: "Sync budget numbers", minutes: 30, due: "" });
  const agenda = (ctx: {
    event: { description: string };
    past_meetings: { title: string }[];
    related_tasks: { title: string }[];
  }) =>
    [
      ctx.event.description,
      "Agenda:",
      `1. Follow up on ${ctx.past_meetings.map((m) => m.title).join(", ")}`,
      "2. Decide the budget owner for the next quarter and write it down for everyone",
      "Prep plan:",
      ...ctx.related_tasks.map((t) => `- Finish ${t.title}`),
      "- Read the notes of the last meeting the evening before",
    ].join("\n");
  llm.on(/agenda and a prep plan/i, [
    {
      tools: [
        {
          name: "list_events",
          arguments: { start: iso(at(thu, "00:00")), end: iso(at(addDays(thu, 1), "00:00")) },
        },
      ],
    },
    (req) => {
      const e = toolJson<{ events: { id: string; title: string }[] }>(req, "list_events").events;
      return {
        tools: [
          {
            name: "get_meeting_context",
            arguments: { event_id: e.find((x) => x.title === "Weekly sync")?.id },
          },
        ],
      };
    },
    (req) => {
      const ctx = toolJson<Parameters<typeof agenda>[0] & { event: { id: string } }>(
        req,
        "get_meeting_context",
      );
      return {
        tools: [
          {
            name: "propose_update_event",
            arguments: { event_id: ctx.event.id, description: agenda(ctx) },
          },
        ],
      };
    },
    { content: "The agenda waits for your approval." },
  ]);

  await page.goto(`/?week=${W}`);
  await openAssistant(page);
  expect(await say(page, "Write an agenda and a prep plan for the weekly sync")).toBe(200);
  const description = [
    "Room 4",
    "Agenda:",
    "1. Follow up on Kickoff",
    "2. Decide the budget owner for the next quarter and write it down for everyone",
    "Prep plan:",
    "- Finish Sync budget numbers",
    "- Read the notes of the last meeting the evening before",
  ].join("\n");
  const call = llm.requests
    .at(-1)
    ?.messages.flatMap((m) => m.tool_calls ?? [])
    .find((c) => c.function.name === "propose_update_event");
  expect(JSON.parse(call?.function.arguments ?? "{}").description).toBe(description);
  const card = proposal(page, "New description for “Weekly sync”");
  await expect(card).toContainText("Waiting for your approval");
  // The whole new description is readable before approval, in the chat and in preview mode.
  expect(description.length).toBeGreaterThan(200);
  await expect(card.getByTestId("proposal-description")).toHaveText(description);
  await expect(
    previewPanel(page).getByTestId("staged-change").getByTestId("staged-description"),
  ).toHaveText(description);

  // Nothing reaches the event or the guest before approval.
  await planNow(page);
  const sync = async () => named(await weekEvents(cal), "Weekly sync")[0];
  expect((await sync())?.description).toBe("Room 4");
  expect(await mail.count(COLLEAGUE_EMAIL, /Updated: Weekly sync/)).toBe(0);

  await page.reload();
  await openAssistant(page);
  await card.getByRole("button", { name: "Accept" }).click();
  await expect(card).toContainText("Accepted");
  await chatPanel(page).getByRole("button", { name: "Close" }).click();
  await reviewAndApply(page);
  await expect(page.getByTestId("apply-summary")).toContainText("Applied 1");
  await eventually(sync, (e) => expect(e?.description).toBe(description));
  expect([local((await sync())?.start ?? 0)]).toEqual([`${thu} 10:00`]);
  const sent = (await mail.message(COLLEAGUE_EMAIL, /Updated: Weekly sync/)).text;
  expect(sent).toContain("New description:");
  expect(sent).toContain("1. Follow up on Kickoff");
  expect(sent).not.toContain("moved to");
  await page.reload();
  await expect(previewPanel(page).getByTestId("staged-change")).toHaveCount(0);
  await openAssistant(page);
  await expect(proposal(page, "New description for “Weekly sync”")).toContainText("Applied");
});

test("an agenda on an all-day event keeps it all-day; a move and an agenda for one event are one change, and both apply (assistant-chat; agendas and prep plans)", async ({
  page,
  cal,
  signIn,
  llm,
}) => {
  const wed = addDays(W, 2);
  await cal.addAllDay(thu, "Offsite", true);
  await cal.addEvent({ title: "Planning", start: at(wed, "10:00"), end: at(wed, "11:00") });
  await signIn();
  const listed = (day: string) => ({
    tools: [
      {
        name: "list_events",
        arguments: { start: iso(at(day, "00:00")), end: iso(at(addDays(day, 1), "00:00")) },
      },
    ],
  });
  const idOf = (req: ChatRequest, title: string) =>
    toolJson<{ events: { id: string; title: string }[] }>(req, "list_events").events.find(
      (e) => e.title === title,
    )?.id;
  llm.on(/agenda for the offsite/i, [
    listed(thu),
    (req) => ({
      tools: [
        {
          name: "propose_update_event",
          arguments: { event_id: idOf(req, "Offsite"), description: "Agenda: goals for 2027" },
        },
      ],
    }),
    { content: "Staged." },
  ]);
  llm.on(/move the offsite/i, [
    listed(thu),
    (req) => ({
      tools: [
        {
          name: "propose_update_event",
          arguments: {
            event_id: idOf(req, "Offsite"),
            start: iso(at(addDays(thu, 1), "09:00")),
            end: iso(at(addDays(thu, 1), "17:00")),
          },
        },
      ],
    }),
    { content: "I could not move it." },
  ]);
  llm.on(/move planning/i, [
    listed(wed),
    (req) => ({
      tools: [
        {
          name: "propose_update_event",
          arguments: {
            event_id: idOf(req, "Planning"),
            start: iso(at(wed, "14:00")),
            end: iso(at(wed, "15:00")),
            description: "Agenda: roadmap",
          },
        },
      ],
    }),
    { content: "Staged." },
  ]);
  await page.goto(`/?week=${W}`);
  await openAssistant(page);
  expect(await say(page, "Write an agenda for the offsite")).toBe(200);
  await expect(proposal(page, "“Offsite”")).toContainText(`${thu} (all day)`);
  // A timed move of the all-day event is refused by the app, so nothing more is staged.
  expect(await say(page, "Move the offsite to Friday 09:00")).toBe(200);
  const refused = toolResults(llm.requests.at(-1) as ChatRequest).at(-1)?.content ?? "";
  expect(refused).toContain("Error: Tempoloom cannot move all-day events yet");
  await expect(chatPanel(page).getByTestId("chat-proposal")).toHaveCount(1);
  expect(await say(page, "Move planning to 14:00 and add an agenda")).toBe(200);
  // One change for the move and the agenda of Planning, one for the offsite.
  await expect(chatPanel(page).getByTestId("chat-proposal")).toHaveCount(2);
  const both = proposal(page, "Move “Planning”");
  await expect(both).toContainText("14:00");
  await expect(both).toContainText("with a new description");
  await expect(both.getByTestId("proposal-description")).toHaveText("Agenda: roadmap");
  await page.reload();
  await expect(previewPanel(page).getByTestId("staged-change")).toHaveCount(2);

  await planNow(page);
  const offsite = async () => named(await weekEvents(cal), "Offsite")[0];
  const planning = async () => named(await weekEvents(cal), "Planning")[0];
  expect((await offsite())?.description).toBe("");
  expect(local((await planning())?.start ?? 0)).toBe(`${wed} 10:00`);

  await openAssistant(page);
  for (const s of ["“Offsite”", "Move “Planning”"]) {
    await proposal(page, s).getByRole("button", { name: "Accept" }).click();
    await expect(proposal(page, s)).toContainText("Accepted");
  }
  await chatPanel(page).getByRole("button", { name: "Close" }).click();
  await reviewAndApply(page);
  await expect(page.getByTestId("apply-summary")).toContainText("Applied 2");
  await eventually(offsite, (e) => expect(e?.description).toBe("Agenda: goals for 2027"));
  const day = await offsite();
  expect(day?.allDay).toBe(true);
  expect(local(day?.start ?? 0)).toBe(`${thu} 00:00`);
  const moved = await eventually(planning, (e) => expect(e?.description).toBe("Agenda: roadmap"));
  expect([local(moved?.start ?? 0), local(moved?.end ?? 0)]).toEqual([
    `${wed} 14:00`,
    `${wed} 15:00`,
  ]);
  await page.reload();
  await expect(previewPanel(page).getByTestId("staged-change")).toHaveCount(0);
  expect((await offsite())?.allDay).toBe(true);
});

test("the chat memory limit refuses a new memory by chat and a Save past the limit, with the limit in the message; without a limit both work (plans-feature-inventory rules 2, 4; assistant-chat rule 22)", async ({
  page,
  signIn,
  llm,
  app,
}) => {
  const remember = (text: string) => [
    { tools: [{ name: "save_memory", arguments: { text } }] },
    (req: ChatRequest) => ({ content: toolResults(req).at(-1)?.content ?? "" }),
  ];
  llm.on(/no meetings on friday/i, remember("No meetings on Friday"));
  llm.on(/mornings for focus/i, remember("Mornings for focus"));
  llm.on(/short calls/i, remember("Short calls only"));
  await signIn();
  await page.goto(`/?week=${W}`);
  await openAssistant(page);
  const memories = async () => {
    await page.reload();
    await openAssistant(page);
    await chatPanel(page).getByRole("button", { name: "Memories" }).click();
    const texts = await chatPanel(page).getByTestId("memory").locator("span").allTextContents();
    await chatPanel(page).getByRole("button", { name: "Memories" }).click();
    return texts;
  };
  const save = async (text: string) => {
    const card = chatPanel(page).getByTestId("chat-memory").filter({ hasText: text });
    const answer = page.waitForResponse((r) => /\/memories\/[^/]+\/save$/.test(r.url()));
    await card.getByRole("button", { name: "Save memory" }).click();
    return (await answer).status();
  };

  // Without a limit: one saved, one more proposed.
  await say(page, "Remember: no meetings on Friday");
  expect(await save("No meetings on Friday")).toBe(200);
  await say(page, "Remember: mornings for focus");
  await expect(
    chatPanel(page).getByTestId("chat-memory").filter({ hasText: "Mornings for focus" }),
  ).toContainText("Save memory");

  // A limit of 1: Save of the proposed one is refused and names the limit.
  app.cli("limit", "--name", "max_chat_memories", "--value", "1");
  expect(await save("Mornings for focus")).toBe(409);
  const message = "This server allows at most 1 chat memory per person.";
  await expect(chatPanel(page).getByTestId("assistant-error")).toHaveText(message);
  expect(await memories()).toEqual(["No meetings on Friday"]);

  // The model gets the refusal instead of a proposal; nothing waits for approval.
  await say(page, "Remember: short calls");
  const result = toolResults(llm.requests.at(-1) as ChatRequest).at(-1)?.content ?? "";
  expect(result).toContain(`Error: ${message}`);
  await expect(chatPanel(page).getByTestId("chat-assistant").last()).toContainText(message);
  await expect(
    chatPanel(page).getByTestId("chat-memory").filter({ hasText: "Short calls only" }),
  ).toHaveCount(0);
  expect(await memories()).toEqual(["No meetings on Friday"]);

  // Without the limit again, the proposed memory saves.
  app.cli("limit", "--name", "max_chat_memories", "--value", "none");
  await page.reload();
  await openAssistant(page);
  expect(await save("Mornings for focus")).toBe(200);
  expect(await memories()).toEqual(["No meetings on Friday", "Mornings for focus"]);
});

test("find time with a colleague stages an event with them as attendee inside their meeting hours, written only after approval @llm-real", async ({
  page,
  cal,
  signIn,
  colleague,
  mail,
}) => {
  test.skip(!REAL_LLM, "Needs the real model: run scripts/e2e-llm.sh");
  test.setTimeout(400_000);
  await colleague.cal.addEvent({ title: "V busy", start: at(tue, "13:00"), end: at(tue, "14:00") });
  const pv = await teamOfTwo(page, signIn, colleague, mail);
  await meetingHoursFrom(pv, "13:00");
  await page.goto(`/?week=${W}`);
  await openAssistant(page);
  expect(
    await say(
      page,
      `Find 30 minutes with ${COLLEAGUE_EMAIL} on ${tue} for "Pairing" and stage the earliest free slot. Do not ask me questions.`,
      150_000,
    ),
  ).toBe(200);
  const card = chatPanel(page).getByTestId("chat-proposal").filter({ hasText: "Pairing" });
  await expect(card.first()).toContainText(COLLEAGUE_EMAIL);
  await planNow(page);
  expect(named(await weekEvents(cal), "Pairing")).toHaveLength(0);
  await chatPanel(page).getByRole("button", { name: "Close" }).click();
  await page.reload();
  await reviewAndApply(page);
  const [made] = await eventually(
    async () => (await weekEvents(cal)).filter((e) => /pairing/i.test(e.summary)),
    (l) => expect(l.length).toBeGreaterThan(0),
  );
  // V's meeting hours start at 13:00 and V is busy until 14:00.
  expect(made?.start).toBeGreaterThanOrEqual(at(tue, "14:00"));
  expect(made?.end).toBeLessThanOrEqual(at(tue, "17:00"));
  expect((await cal.guests(made?.id ?? "")).map((g) => g.email)).toContain(COLLEAGUE_EMAIL);
});
