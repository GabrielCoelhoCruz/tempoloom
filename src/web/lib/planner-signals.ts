// State that the planner shares with its parts that load on demand
// (src/web/views/planner-now.tsx): work block previews, flagged conflicts,
// the second time column and a reload request.
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
