// Assistant chat (docs/specs/assistant-chat.md) through the planner panel,
// with the fake OpenAI-compatible model (tests/e2e/fake-llm.ts). The fake only
// answers scripted turns; each test checks what the app sent it (tools, system
// prompt, history) and what the app did with the tool calls (calendar reads,
// staged changes, memories), against the real CalDAV server.
//
// Ways this can fail, each covered below:
// - the panel is missing from the planner, or a reload loses the conversation;
// - tools read nothing real, or the model gets no history or planner context;
// - a chat change reaches the calendar before the user approves it, or not after;
// - a discarded change is written anyway;
// - an invitation answer goes out before approval;
// - a memory is not stored, not listed after reload, not sent to the model,
//   triggers a change on its own, or survives delete;
// - the usage limit lets more messages reach the model, or does not say when it resets;
// - the team switch off still sends messages, or shows no notice and admin link;
// - a failed model call loses the draft, saves half a turn, or logs the key.
import { addDays } from "../../src/shared/time.ts";
import { chatPanel, openAssistant, proposal, say } from "./assistant-helpers.ts";
import { type ChatRequest, toolJson } from "./fake-llm.ts";
import {
  at,
  type CalendarDriver,
  COLLEAGUE_EMAIL,
  EMAIL,
  eventually,
  expect,
  local,
  planNow,
  test,
} from "./fixtures.ts";
import { W } from "./helpers.ts";
import { iso, previewPanel, reviewAndApply, stagedRow } from "./preview-helpers.ts";
import { openTeam, teamOfTwo } from "./team-helpers.ts";

const tue = addDays(W, 1);
const wed = addDays(W, 2);
const thu = addDays(W, 3);
const weekEvents = (cal: CalendarDriver) => cal.events(at(W, "00:00"), at(addDays(W, 7), "00:00"));
const named = <T extends { summary: string }>(evs: T[], title: string) =>
  evs.filter((e) => e.summary === title);

interface Listed {
  events: { id: string; title: string; start: string; end: string }[];
}
const idOf = (req: ChatRequest, title: string) => {
  const e = toolJson<Listed>(req, "list_events").events.find((x) => x.title === title);
  if (!e) throw new Error(`no ${title} in list_events`);
  return e.id;
};
const listDay = (day: string) => ({
  tools: [
    {
      name: "list_events",
      arguments: { start: iso(at(day, "00:00")), end: iso(at(addDays(day, 1), "00:00")) },
    },
  ],
});
const systemOf = (req: ChatRequest | undefined) =>
  req?.messages.find((m) => m.role === "system")?.content ?? "";

test("the assistant panel in the planner reads the calendar through tools and keeps the conversation after reload; a failed call keeps the draft (assistant-chat rules 1, 3, 11, edge case 5)", async ({
  page,
  cal,
  signIn,
  llm,
  app,
}) => {
  await cal.addEvent({ title: "Design review", start: at(tue, "10:00"), end: at(tue, "11:00") });
  await signIn();
  await page.goto(`/?week=${W}`);
  await expect(page.locator(".ev", { hasText: "Design review" })).toBeVisible();

  llm.on(/what is on tuesday/i, [
    listDay(tue),
    (req) => ({
      content: `Tuesday: ${toolJson<Listed>(req, "list_events")
        .events.map((e) => `${e.title} at ${local(Date.parse(e.start)).slice(11)}`)
        .join(", ")}.`,
    }),
  ]);
  llm.on(/and wednesday/i, [{ content: "Wednesday has nothing yet." }]);
  llm.on(/break please/i, [{ status: 500 }]);

  await openAssistant(page);
  expect(await say(page, "What is on Tuesday?")).toBe(200);
  // The reply holds what the tool read from the calendar: the app ran list_events.
  await expect(chatPanel(page).getByTestId("chat-assistant")).toHaveText([
    "Tuesday: Design review at 10:00.",
  ]);
  const [first] = llm.requests;
  const tools = first?.tools?.map((t) => t.function.name) ?? [];
  expect(tools).toEqual(
    expect.arrayContaining([
      "list_events",
      "find_free_time",
      "propose_create_event",
      "propose_update_event",
      "propose_delete_event",
      "propose_rsvp",
      "save_memory",
    ]),
  );
  // The chat never applies: the user applies in the planner (rule 12).
  expect(tools).not.toContain("apply_staged_changes");
  expect(first?.authorization).toBe("Bearer fake-llm-key");
  expect(first?.model).toBe("fake-model");
  // The chat message context: the dates shown in the planner (proposal in the spec).
  expect(systemOf(first)).toContain(`The planner shows the dates ${W} to ${addDays(W, 7)}`);
  expect(systemOf(first)).toContain("Europe/Berlin");

  // Rule 11: the second question goes with the first turn, tool calls included.
  expect(await say(page, "And Wednesday?")).toBe(200);
  await expect(chatPanel(page).getByTestId("chat-assistant").last()).toHaveText(
    "Wednesday has nothing yet.",
  );
  const second = llm.requests.at(-1);
  expect(second?.messages.map((m) => m.role)).toEqual([
    "system",
    "user",
    "assistant",
    "tool",
    "assistant",
    "user",
  ]);
  expect(second?.messages[1]?.content).toBe("What is on Tuesday?");
  expect(second?.messages[4]?.content).toBe("Tuesday: Design review at 10:00.");

  // Edge case 5: the provider fails; the panel shows an error and keeps the draft.
  expect(await say(page, "break please")).toBe(502);
  await expect(chatPanel(page).getByTestId("assistant-error")).toContainText("HTTP 500");
  await expect(chatPanel(page).getByLabel("Message to the assistant")).toHaveValue("break please");

  await page.reload();
  await openAssistant(page);
  await expect(chatPanel(page).getByTestId("chat-user")).toHaveText([
    "What is on Tuesday?",
    "And Wednesday?",
  ]);
  await expect(chatPanel(page).getByTestId("chat-assistant")).toHaveText([
    "Tuesday: Design review at 10:00.",
    "Wednesday has nothing yet.",
  ]);
  // The key and the endpoint never reach the server log.
  const log = app.log.join("");
  expect(log).not.toContain("fake-llm-key");
  expect(log).not.toContain(llm.url);
});

test("events made, moved, resized and deleted by chat wait in preview mode; nothing is written before approval, the accepted ones after apply (assistant-chat rules 4, 12-14; preview mode rules 1, 6-8)", async ({
  page,
  cal,
  signIn,
  llm,
}) => {
  await cal.addEvent({ title: "Standup", start: at(tue, "09:00"), end: at(tue, "09:30") });
  await cal.addEvent({ title: "Planning", start: at(wed, "10:00"), end: at(wed, "11:00") });
  await cal.addEvent({ title: "Old sync", start: at(thu, "14:00"), end: at(thu, "15:00") });
  await signIn();
  await page.goto(`/?week=${W}`);
  await expect(page.locator(".ev", { hasText: "Old sync" })).toBeVisible();

  llm.on(/book deep work/i, [
    {
      tools: [
        {
          name: "propose_create_event",
          arguments: {
            title: "Deep work",
            start: iso(at(tue, "13:00")),
            end: iso(at(tue, "15:00")),
            reason: "You asked for deep work.",
          },
        },
      ],
    },
    { content: "I staged Deep work on Tuesday 13:00 to 15:00. It waits for your approval." },
  ]);
  llm.on(/move the standup/i, [
    listDay(tue),
    (req) => ({
      tools: [
        {
          name: "propose_update_event",
          arguments: {
            event_id: idOf(req, "Standup"),
            start: iso(at(tue, "11:00")),
            end: iso(at(tue, "11:30")),
          },
        },
      ],
    }),
    { content: "The move waits for your approval." },
  ]);
  llm.on(/planning until noon/i, [
    listDay(wed),
    (req) => ({
      tools: [
        {
          name: "propose_update_event",
          arguments: { event_id: idOf(req, "Planning"), end: iso(at(wed, "12:00")) },
        },
      ],
    }),
    { content: "The longer Planning waits for your approval." },
  ]);
  llm.on(/delete the old sync/i, [
    listDay(thu),
    (req) => ({
      tools: [{ name: "propose_delete_event", arguments: { event_id: idOf(req, "Old sync") } }],
    }),
    { content: "The delete waits for your approval." },
  ]);

  await openAssistant(page);
  await say(page, "Book deep work on Tuesday from 13:00 to 15:00");
  await expect(proposal(page, "Deep work")).toContainText("Waiting for your approval");
  await say(page, "Move the standup to 11:00");
  await expect(proposal(page, "Move “Standup”")).toContainText("Waiting for your approval");
  await say(page, "Make planning until noon");
  await expect(proposal(page, "Move “Planning”")).toContainText("12:00");
  await say(page, "Delete the old sync");
  await expect(proposal(page, "Delete “Old sync”")).toContainText("Waiting for your approval");

  // Rule 12: nothing reached the calendar.
  await planNow(page);
  const before = await weekEvents(cal);
  expect(named(before, "Deep work")).toHaveLength(0);
  expect(named(before, "Standup").map((e) => local(e.start))).toEqual([`${tue} 09:00`]);
  expect(named(before, "Planning").map((e) => local(e.end))).toEqual([`${wed} 11:00`]);
  expect(named(before, "Old sync")).toHaveLength(1);

  // Preview mode shows the four changes from the chat, and so does the panel after reload.
  await page.reload();
  await expect(previewPanel(page).getByTestId("staged-change")).toHaveCount(4);
  await expect(stagedRow(page, "Deep work")).toContainText("Assistant chat");
  await expect(stagedRow(page, "Deep work")).toContainText("You asked for deep work.");
  await expect(page.locator(".ev-staged-new", { hasText: "Deep work" })).toBeVisible();
  await openAssistant(page);
  await expect(chatPanel(page).getByTestId("chat-proposal")).toHaveCount(4);

  // Rule 13: accept three, discard one, from the chat.
  for (const s of ["Deep work", "Move “Standup”", "Move “Planning”"]) {
    await proposal(page, s).getByRole("button", { name: "Accept" }).click();
    await expect(proposal(page, s)).toContainText("Accepted");
  }
  await proposal(page, "Delete “Old sync”").getByRole("button", { name: "Discard" }).click();
  await expect(proposal(page, "Delete “Old sync”")).toContainText("Discarded");
  await chatPanel(page).getByRole("button", { name: "Close" }).click();

  // Rule 14: apply follows preview mode.
  await reviewAndApply(page);
  await expect(page.getByTestId("apply-summary")).toContainText("Applied 3");
  const after = await eventually(
    () => weekEvents(cal),
    (evs) => expect(named(evs, "Deep work")).toHaveLength(1),
  );
  expect(named(after, "Deep work").map((e) => [local(e.start), local(e.end)])).toEqual([
    [`${tue} 13:00`, `${tue} 15:00`],
  ]);
  expect(named(after, "Standup").map((e) => [local(e.start), local(e.end)])).toEqual([
    [`${tue} 11:00`, `${tue} 11:30`],
  ]);
  expect(named(after, "Planning").map((e) => [local(e.start), local(e.end)])).toEqual([
    [`${wed} 10:00`, `${wed} 12:00`],
  ]);
  expect(named(after, "Old sync")).toHaveLength(1);

  await page.reload();
  await expect(previewPanel(page).getByTestId("staged-change")).toHaveCount(0);
  await openAssistant(page);
  await expect(proposal(page, "Deep work")).toContainText("Applied");
  await expect(proposal(page, "Delete “Old sync”")).toContainText("Discarded");
});

test("an invitation is answered by chat only after approval (assistant-chat rule 4; preview mode rules 8, 9)", async ({
  page,
  cal,
  signIn,
  llm,
}) => {
  await cal.addInvite({
    title: "Budget review",
    start: at(wed, "15:00"),
    end: at(wed, "16:00"),
    answer: "NEEDS-ACTION",
  });
  await signIn();
  await page.goto(`/?week=${W}`);
  await expect(page.locator(".ev", { hasText: "Budget review" })).toBeVisible();
  llm.on(/accept the budget review/i, [
    listDay(wed),
    (req) => ({
      tools: [
        {
          name: "propose_rsvp",
          arguments: { event_id: idOf(req, "Budget review"), response: "accepted" },
        },
      ],
    }),
    { content: "Your answer waits for your approval." },
  ]);
  await openAssistant(page);
  await say(page, "Accept the budget review");
  await expect(proposal(page, "Accept “Budget review”")).toContainText("Waiting for your approval");

  await planNow(page);
  const answer = async () => named(await weekEvents(cal), "Budget review")[0]?.selfResponse;
  expect(await answer()).toBe("needsAction");
  await page.reload();
  await openAssistant(page);
  await proposal(page, "Accept “Budget review”").getByRole("button", { name: "Accept" }).click();
  await expect(proposal(page, "Accept “Budget review”")).toContainText("Accepted");
  await chatPanel(page).getByRole("button", { name: "Close" }).click();
  await reviewAndApply(page);
  await expect(page.getByTestId("apply-summary")).toContainText("Applied 1");
  await eventually(answer, (v) => expect(v).toBe("accepted"));
  await page.reload();
  await expect(previewPanel(page).getByTestId("staged-change")).toHaveCount(0);
});

test("chat memories: remember stores one, the list keeps it after reload, the model gets it as a suggestion only, delete removes it (assistant-chat rules 22-25)", async ({
  page,
  cal,
  signIn,
  llm,
}) => {
  await cal.addInvite({
    title: "Roadmap chat",
    start: at(tue, "15:00"),
    end: at(tue, "16:00"),
    answer: "NEEDS-ACTION",
  });
  await signIn();
  await page.goto(`/?week=${W}`);
  await expect(page.locator(".ev", { hasText: "Roadmap chat" })).toBeVisible();
  const memory = "I accept invitations from ana@example.com";
  llm.on(/^remember/i, [
    { tools: [{ name: "save_memory", arguments: { text: memory, people: ["Ana"] } }] },
    { content: "I will remember that." },
  ]);
  llm.on(/invitations to answer/i, [
    listDay(tue),
    { content: "Roadmap chat waits for an answer. Your memory suggests accepting it." },
  ]);

  await openAssistant(page);
  await say(page, "Remember: I accept invitations from ana@example.com");
  await expect(chatPanel(page).getByTestId("chat-memory")).toContainText(memory);
  await page.reload();
  await openAssistant(page);
  await chatPanel(page).getByRole("button", { name: "Memories" }).click();
  await expect(chatPanel(page).getByTestId("memory")).toHaveText([`${memory}Delete`]);

  // Rule 24: the model gets the memory; the memory itself stages nothing.
  await chatPanel(page).getByRole("button", { name: "Memories" }).click();
  await say(page, "Any invitations to answer?");
  await expect(chatPanel(page).getByTestId("chat-assistant").last()).toContainText(
    "suggests accepting",
  );
  expect(systemOf(llm.requests.at(-1))).toContain(`- ${memory}`);
  await expect(chatPanel(page).getByTestId("chat-proposal")).toHaveCount(0);
  await page.reload();
  await expect(previewPanel(page).getByTestId("staged-change")).toHaveCount(0);
  await planNow(page);
  expect(named(await weekEvents(cal), "Roadmap chat")[0]?.selfResponse).toBe("needsAction");

  // Rule 23: delete it; it is gone after reload and from the next prompt.
  await openAssistant(page);
  await chatPanel(page).getByRole("button", { name: "Memories" }).click();
  const deleted = page.waitForResponse(
    (r) => r.url().includes("/api/assistant/memories/") && r.request().method() === "DELETE",
  );
  await chatPanel(page).getByTestId("memory").getByRole("button", { name: "Delete" }).click();
  expect((await deleted).status()).toBe(200);
  await expect(chatPanel(page).getByTestId("memory")).toHaveCount(0);
  await page.reload();
  await openAssistant(page);
  await chatPanel(page).getByRole("button", { name: "Memories" }).click();
  await expect(chatPanel(page).getByText("No memories.")).toBeVisible();
  await chatPanel(page).getByRole("button", { name: "Memories" }).click();
  await say(page, "Any invitations to answer now?");
  await expect(chatPanel(page).getByTestId("chat-assistant").last()).toContainText("Roadmap chat");
  expect(systemOf(llm.requests.at(-1))).not.toContain(memory);
  expect(systemOf(llm.requests.at(-1))).toContain("The user has no memories saved.");
});

test("the usage limit stops chat with the limit and its reset time; without a limit chat goes on (assistant-chat rule 27; plans-feature-inventory rule 2)", async ({
  page,
  signIn,
  llm,
  app,
}) => {
  llm.on(/hello/i, [{ content: "Hello! How can I help?" }]);
  await signIn();
  // Without a limit, two messages go through.
  await page.goto(`/?week=${W}`);
  await openAssistant(page);
  expect(await say(page, "hello 1")).toBe(200);
  expect(await say(page, "hello 2")).toBe(200);
  expect(llm.requests).toHaveLength(2);

  app.cli("limit", "--name", "assistant_chat_quota", "--value", "3");
  expect(await say(page, "hello 3")).toBe(200);
  expect(llm.requests).toHaveLength(3);
  const limit = chatPanel(page).getByTestId("assistant-limit");
  await expect(limit).toContainText(
    "This server allows 3 assistant chat messages per person per day.",
  );
  const tomorrow = addDays(
    new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" }),
    1,
  );
  await expect(limit).toContainText(`It resets at`);
  await expect(limit).toContainText(`${tomorrow} 00:00`);
  // The fourth message is refused on the server: the model gets nothing.
  expect(await say(page, "hello 4")).toBe(429);
  expect(llm.requests).toHaveLength(3);
  await expect(chatPanel(page).getByLabel("Message to the assistant")).toHaveValue("hello 4");
  await page.reload();
  await openAssistant(page);
  await expect(chatPanel(page).getByTestId("assistant-limit")).toContainText(`${tomorrow} 00:00`);

  app.cli("limit", "--name", "assistant_chat_quota", "--value", "none");
  await page.reload();
  await openAssistant(page);
  await expect(chatPanel(page).getByTestId("assistant-limit")).toHaveCount(0);
  expect(await say(page, "hello 5")).toBe(200);
  expect(llm.requests).toHaveLength(4);
});

test("the team switch turns chat off for members with a notice and the admin list; on again, chat replies (teams-settings-templates rules 13-14, T4; assistant-chat rule 2)", async ({
  page,
  signIn,
  colleague,
  mail,
  llm,
}) => {
  llm.on(/are you there/i, [{ content: "Yes, I am here." }]);
  const pb = await teamOfTwo(page, signIn, colleague, mail);

  // The admin turns chat off for the team.
  await openTeam(page);
  const form = page.getByTestId("team-settings");
  await expect(form.getByLabel("Assistant chat for all members")).toBeChecked();
  await form.getByLabel("Assistant chat for all members").uncheck();
  await form.getByRole("button", { name: "Save team settings" }).click();
  await expect(form.getByTestId("team-settings-saved")).toBeVisible();
  await page.reload();
  await expect(
    page.getByTestId("team-settings").getByLabel("Assistant chat for all members"),
  ).not.toBeChecked();

  // The member sees the notice and the admins, and cannot send.
  await pb.goto(`/?week=${W}`);
  await openAssistant(pb);
  const notice = chatPanel(pb).getByTestId("assistant-refusal");
  await expect(notice).toContainText("Assistant chat is off for your team. Ask a team admin");
  await expect(chatPanel(pb).getByLabel("Message to the assistant")).toHaveCount(0);
  await pb.reload();
  await openAssistant(pb);
  await chatPanel(pb).getByText("Who are the team admins?").click();
  await expect(chatPanel(pb).getByTestId("team-admins")).toContainText(EMAIL);
  await expect(chatPanel(pb).getByTestId("team-admins")).not.toContainText(COLLEAGUE_EMAIL);
  // The server refuses a message too, and the model gets nothing.
  const refused = await pb.evaluate(() =>
    fetch("/api/assistant/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "are you there?" }),
    }).then((r) => r.status),
  );
  expect(refused).toBe(403);
  expect(llm.requests).toHaveLength(0);

  // On again: the member's message gets a reply.
  await page.getByTestId("team-settings").getByLabel("Assistant chat for all members").check();
  await page
    .getByTestId("team-settings")
    .getByRole("button", { name: "Save team settings" })
    .click();
  await expect(page.getByTestId("team-settings").getByTestId("team-settings-saved")).toBeVisible();
  await pb.reload();
  await openAssistant(pb);
  expect(await say(pb, "Are you there?")).toBe(200);
  await expect(chatPanel(pb).getByTestId("chat-assistant")).toHaveText(["Yes, I am here."]);
  expect(llm.requests).toHaveLength(1);
});

test("without a configured model the panel says the assistant is not configured and sends nothing (assistant-chat rule 1)", async ({
  page,
  signIn,
  llm,
  app,
}) => {
  app.env.TEMPOLOOM_LLM_BASE_URL = "";
  await app.restart();
  await signIn();
  await page.goto(`/?week=${W}`);
  await openAssistant(page);
  await expect(chatPanel(page).getByTestId("assistant-refusal")).toContainText(
    "The assistant is not configured on this server.",
  );
  await expect(chatPanel(page).getByLabel("Message to the assistant")).toHaveCount(0);
  expect(llm.requests).toHaveLength(0);
});
