// The system prompt of assistant chat (docs/specs/assistant-chat.md). It gives
// the model the time, the planner state (the chat message context), the rules
// of preview mode and the user's memories. Each part is one function in
// PROMPT_PARTS, so a new ability adds a part, not new plumbing.
import { zoneOffset } from "../../shared/time.ts";
import type { Memory } from "./store.ts";

export interface PromptInput {
  name: string;
  email: string;
  zone: string;
  now: number;
  /** The dates shown in the planner, local, end exclusive. */
  shown?: { from: string; to: string } | undefined;
  /** The event selected in the planner. */
  selected?: { id: string; title: string; start: number; end: number } | undefined;
  memories: Memory[];
}

/** An instant as local ISO 8601 with the zone's offset: what the tools take. */
export function localIso(zone: string, t: number): string {
  const off = Math.round(zoneOffset(zone, t) / 60_000);
  const local = new Date(t + off * 60_000).toISOString().slice(0, 19);
  const sign = off < 0 ? "-" : "+";
  const a = Math.abs(off);
  return `${local}${sign}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

type Part = (p: PromptInput) => string | null;

export const PROMPT_PARTS: Part[] = [
  (p) =>
    `You are the assistant in the Tempoloom planner of ${p.name || p.email} (${p.email}). Tempoloom is a calendar planner. Answer in the user's language, briefly.`,
  (p) => {
    const iso = localIso(p.zone, p.now);
    const day = WEEKDAYS[new Date(`${iso.slice(0, 10)}T12:00:00Z`).getUTCDay()];
    return `Now: ${day} ${iso}. The user's time zone: ${p.zone}. Give every time to a tool as ISO 8601 with this offset, unless a date is in another offset period.`;
  },
  (p) =>
    p.shown
      ? `The planner shows the dates ${p.shown.from} to ${p.shown.to} (end exclusive). "This week" and dates without a month mean these dates.`
      : null,
  (p) =>
    p.selected
      ? `The user selected the event "${p.selected.title}" (id ${p.selected.id}, ${localIso(p.zone, p.selected.start)} to ${localIso(p.zone, p.selected.end)}). "This event" means it.`
      : null,
  () =>
    [
      "Rules:",
      "- Read the calendar with the read tools (list_events, find_free_time and others) before you answer about it or propose a change. Use the event ids that list_events gives.",
      "- You never change the calendar yourself. The propose_ tools only stage a change in preview mode; nothing is written and nobody is notified until the user accepts and applies it in the planner. After you stage a change, say in one sentence what you staged and that it waits for the user's approval.",
      "- To move or resize an event, call propose_update_event with the new start and end. To answer an invitation, call propose_rsvp.",
      "- When the request is ambiguous (for example two events or people match), ask one question instead of staging a change.",
      "- When the user asks you to remember something, call save_memory with the preference in the user's words.",
      "- Memories shape your suggestions only. Never stage a change only because a memory says so; when a memory is about the request, mention it. An explicit request wins over a memory.",
      "- A memory names people by name or email. When the user names a person by role (my manager, my reports), ask for a name or an email.",
    ].join("\n"),
  (p) =>
    p.memories.length
      ? `Memories of the user (suggestions only):\n${p.memories.map((m) => `- ${m.text}`).join("\n")}`
      : "The user has no memories saved.",
];

export const systemPrompt = (p: PromptInput) =>
  PROMPT_PARTS.map((part) => part(p))
    .filter((x): x is string => x !== null)
    .join("\n\n");
