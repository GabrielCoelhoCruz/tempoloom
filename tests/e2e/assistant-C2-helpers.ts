// Shared steps of the C2 assistant chat specs (assistant-C2.spec.ts,
// assistant-C2-offer.spec.ts): the library's prompts, opening a prompt entry,
// sending the draft, and reading what the app sent to the fake model.
import type { Page } from "@playwright/test";
import { addDays, utcToLocal, weekdayOf } from "../../src/shared/time.ts";
import { chatPanel } from "./assistant-helpers.ts";
import type { ChatRequest, FakeLlm } from "./fake-llm.ts";
import { at, type CalendarDriver, expect } from "./fixtures.ts";

export const ZONE = "Europe/Berlin";
/** The prompts of automations-library.md, "Entries". */
export const PROMPTS: Record<string, string> = {
  "Back-plan work from due dates":
    "Look at my open tasks with due dates and propose work time before each due date.",
  "What to do now": "Which task should I start now, and why?",
  "Customer onboarding meeting plan":
    "Plan onboarding meetings with this customer: a 60 min kickoff, a 30 min check-in after 1 week and a 30 min review after 30 days.",
  "Work rhythm review":
    "Over the last 4 weeks, when do I do deep work and when do I meet? Suggest a better weekly rhythm.",
  "Cross-team meeting time": "Find the best time this week for a meeting with these colleagues: …",
  "Burnout risk review":
    "Check my last 4 weeks for burnout signs: meetings outside work hours, few breaks, little time off, little focus time.",
  "Team meeting health review":
    "Summarize my team's meeting load and one-on-one time from team stats.",
  "Urgent review meeting":
    "Find the earliest slot this week for an urgent review with these people. You may move my lower-priority items.",
  "Adaptive workday":
    "My day changed: I now work from … to …. Rearrange my flexible items for today.",
  // Entry 21 runs Recommendations for the dates in view (decision: as a request with those dates).
  "Conflict fixes":
    "Recommendations: check the dates shown in the planner for conflicts and other meeting problems, and propose a fix for each.",
  "Plan my day": "Plan my day: place my top tasks in free focus time and add short breaks.",
  "Task re-ranking":
    "Re-rank my open tasks by due date and remaining work, and propose new priorities.",
  "Prep task suggestions":
    "For my meetings in the next 7 days, suggest prep tasks due before each meeting.",
};
export const prompt = (name: string) => {
  const p = PROMPTS[name];
  if (!p) throw new Error(`no prompt ${name}`);
  return p;
};
export const literal = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const matches = (text: string) => new RegExp(`^${literal(text)}$`);

/** Monday of the week the planner shows first: the browser's today. */
export const shownMonday = () => {
  const d = utcToLocal(ZONE, Date.now()).date;
  return addDays(d, 1 - weekdayOf(d));
};
export const systemOf = (req: ChatRequest | undefined) =>
  req?.messages.find((m) => m.role === "system")?.content ?? "";
/** The planner dates the app gave the model, from the data block of the system prompt. */
export const plannerDates = (req: ChatRequest) => {
  const s = systemOf(req);
  const from = /"from": "(\d{4}-\d{2}-\d{2})"/.exec(s)?.[1];
  const to = /"to_exclusive": "(\d{4}-\d{2}-\d{2})"/.exec(s)?.[1];
  if (!from || !to) throw new Error("no planner dates in the system prompt");
  return { from, to };
};
/** The first request of the turn that sent `text`. */
export const turnOf = (llm: FakeLlm, text: string) => {
  const req = llm.requests.find(
    (r) => r.messages.at(-1)?.role === "user" && r.messages.at(-1)?.content === text,
  );
  if (!req) throw new Error(`the model got no “${text}”`);
  return req;
};
export const toolNames = (req: ChatRequest) => req.tools?.map((t) => t.function.name) ?? [];

/** Opens a prompt entry of the library; the planner shows the chat with the prompt in its input box. */
export async function openEntry(page: Page, name: string) {
  await page.getByRole("link", { name: "Library" }).click();
  await expect(page.getByTestId("library-page")).toBeVisible();
  await page.getByRole("tab", { name: "Prompts" }).click();
  await page
    .locator(`[data-entry="${name}"]`)
    .getByRole("button", { name: "Open in chat" })
    .click();
  await expect(page).toHaveURL((u) => u.pathname === "/");
  const box = chatPanel(page).getByLabel("Message to the assistant");
  await expect(box).toHaveValue(prompt(name));
  return box;
}

/** Sends the text in the input box and waits for the answer. */
export async function sendDraft(page: Page): Promise<string> {
  const text = await chatPanel(page).getByLabel("Message to the assistant").inputValue();
  const answer = page.waitForResponse(
    (r) => r.url().endsWith("/api/assistant/messages") && r.request().method() === "POST",
  );
  await chatPanel(page).getByRole("button", { name: "Send" }).click();
  expect((await answer).status()).toBe(200);
  await expect(chatPanel(page).getByTestId("chat-user").last()).toHaveText(text);
  return text;
}

export const reply = (page: Page) => chatPanel(page).getByTestId("chat-assistant").last();
export const weekOf = (cal: CalendarDriver, monday: string) =>
  cal.events(at(monday, "00:00"), at(addDays(monday, 7), "00:00"));
export const named = <T extends { summary: string }>(evs: T[], title: string) =>
  evs.filter((e) => e.summary === title);

/** The proposals of the re-ranking, in the order the model staged them. */
export const RANKS = [
  'New priority P3 to P4 for task "Budget review"',
  'New priority P2 to P1 for task "Quarterly report"',
  'New priority P2 to P3 for task "Expense notes"',
];
/** The priorities on the tasks page of Budget review, Expense notes and Quarterly report. */
export async function expectLevels(page: Page, want: string[]) {
  for (const [i, t] of ["Budget review", "Expense notes", "Quarterly report"].entries())
    await expect(page.locator(`[data-task-title="${t}"]`).getByTestId("task-level"), t).toHaveText(
      want[i] ?? "",
    );
}

export interface Tasks {
  tasks: { id: string; title: string; priority: number; due: string | null }[];
}
export interface Listed {
  events: { id: string; title: string; start: string; end: string }[];
}
export interface Slots {
  slots: { start: string; end: string }[];
  unknown_attendees: string[];
}
