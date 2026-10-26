// State that the planner shares with its parts that load on demand
// (src/web/views/planner-now.tsx): work block previews, flagged conflicts,
// the second time column, a reload request, the open panel and "view as".
import { signal } from "@preact/signals";

export interface BlockPreview {
  taskId: string;
  title: string;
  blocks: { id: string; start: number; end: number }[];
}

/** NXT-50: proposed work blocks, drawn in the week until applied or discarded. */
export const blockPreview = signal<BlockPreview | null>(null);
/** events-external-priority.md rule 8: ids of overlapping external events. */
export const conflictIds = signal<ReadonlySet<string>>(new Set());
/** timezones-home-and-travel.md rule 10: the zone of the second time column. */
export const extraZone = signal<string | null>(null);
/** Bumped when the planner should read its events again. */
export const plannerReload = signal(0);
/** PLN-21: the one panel open beside the week; "details" shows the clicked event. */
export const sidePanel = signal<
  "tasks" | "priorities" | "conflicts" | "details" | "assistant" | null
>(null);
/** assistant-chat.md chat message context: the dates shown and the selected event. */
export const plannerContext = signal<{ from: string; to: string; eventId?: string }>({
  from: "",
  to: "",
});
/** PLN-6: show the week as the user sees it, or as others see it. */
export const viewAs = signal<"me" | "others">("me");
/** Text that "Reply in chat" in preview mode puts in the assistant's draft. */
export const chatDraft = signal<string | null>(null);
