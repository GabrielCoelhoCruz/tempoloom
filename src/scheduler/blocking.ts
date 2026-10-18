// Which external time blocks managed items (planning-scheduler.md SCH-20..33,
// events-tags.md). Tasks, habits, focus time and buffers share one view.
import type { ExternalEvent } from "./model.ts";
import type { Interval } from "./timeset.ts";

export const TAG_FREE = "#tl_free";
export const TAG_BUSY = "#tl_busy";
export const TAG_FOCUS = "#tl_focus";

export function hasTag(e: Pick<ExternalEvent, "title" | "description">, tag: string): boolean {
  const t = tag.toLowerCase();
  return e.title.toLowerCase().includes(t) || e.description.toLowerCase().includes(t);
}

/** True when the user takes part: organizer, own event, or answered yes or maybe. */
export function attends(e: ExternalEvent): boolean {
  if (e.selfResponse === "declined") return false;
  if (e.selfResponse === "needsAction" && !e.organizerSelf) return false;
  return true;
}

/** True when the event blocks tasks, habits, focus time and buffers. */
export function blocksPlanning(e: ExternalEvent): boolean {
  if (e.bookedViaLink) return true;
  if (e.eventType === "workingLocation") return false;
  if (!e.busy) return hasTag(e, TAG_BUSY);
  if (!attends(e)) return false;
  return !hasTag(e, TAG_FREE);
}

export function blockingIntervals(events: ExternalEvent[]): Interval[] {
  return events.filter(blocksPlanning).map((e) => ({ start: e.start, end: e.end }));
}

export function allDayBlocks(events: ExternalEvent[]): Interval[] {
  return events
    .filter((e) => e.allDay && blocksPlanning(e))
    .map((e) => ({ start: e.start, end: e.end }));
}

const FLIGHT_NUMBER = /\b[A-Z0-9]{2}\s?\d{1,4}\b/;

/** A title with the word "flight" and a flight number (buffers-travel.md rule 2). */
export function isFlightTitle(title: string): boolean {
  return /\bflight\b/i.test(title) && FLIGHT_NUMBER.test(title);
}
