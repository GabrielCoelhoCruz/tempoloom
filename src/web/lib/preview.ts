// Preview mode in the planner (assistant-preview-mode.md rule 4): the week shows
// staged changes on top of the live calendar. The preview panel fills `overlay`.
import { signal } from "@preact/signals";
import type { WeekEvent } from "../views/week.tsx";

export interface OverlayItem {
  changeId: string;
  op: "create" | "move" | "delete";
  title: string;
  start: number;
  end: number;
  /** The live event that a move or delete changes. */
  eventId?: string;
}

export const overlay = signal<OverlayItem[]>([]);

/** New and moved events get a box at their staged time; changed live events get a mark. */
export function withPreview(events: WeekEvent[], items: OverlayItem[]): WeekEvent[] {
  if (items.length === 0) return events;
  const marks = new Map<string, "from" | "deleted">();
  for (const i of items)
    if (i.eventId && i.op !== "create")
      marks.set(i.eventId, i.op === "delete" ? "deleted" : "from");
  const out = events.map((e) => {
    const staged = marks.get(e.id);
    return staged ? { ...e, staged, movable: false } : e;
  });
  items.forEach((i, n) => {
    if (i.op === "delete") return;
    out.push({
      id: `staged:${i.changeId}:${n}`,
      start: i.start,
      end: i.end,
      title: i.title,
      kind: "staged",
      busy: true,
      locked: false,
      movable: false,
      staged: "new",
    });
  });
  return out;
}
