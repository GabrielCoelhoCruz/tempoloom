// Which external time blocks managed items (planning-scheduler.md SCH-20..33,
// events-tags.md). Tasks, habits, focus time and buffers share one view.
import type { ExternalEvent } from "./model.ts";
import type { Interval } from "./timeset.ts";

export const TAG_FREE = "#tl_free";
export const TAG_BUSY = "#tl_busy";
export const TAG_FOCUS = "#tl_focus";

/**
 * events-tags.md: the tag in the title, the description or the user's own RSVP
 * note, as a whole token in any case. Before it: the start or a character that
 * is not a letter, digit or `_`; after it: the end, whitespace or punctuation
 * other than `_` (`#tl_freedom` and `x#tl_free` do not match).
 */
export function hasTag(e: ExternalEvent | TagText, tag: string): boolean {
  const re = tagPattern(tag);
  return re.test(e.title) || re.test(e.description) || re.test(e.rsvpNote ?? "");
}

/** The three texts where tags count; every place that reads tags passes all three. */
export interface TagText {
  title: string;
  description: string;
  rsvpNote: string;
}

/** The tag texts of a cached event row. */
export function tagText(e: { summary: string; description: string; rsvp_note: string }): TagText {
  return { title: e.summary, description: e.description, rsvpNote: e.rsvp_note };
}

const patterns = new Map<string, RegExp>();
function tagPattern(tag: string): RegExp {
  let re = patterns.get(tag);
  if (!re) {
    const t = tag.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    re = new RegExp(`(^|[^\\p{L}\\p{N}_])${t}(?![\\p{L}\\p{N}_])`, "iu");
    patterns.set(tag, re);
  }
  return re;
}

/**
 * True when the user takes part: organizer, own event, or answered yes or maybe.
 * Someone else's event with guests that does not list the user (an invitation
 * sent only to a mailing list) is unanswered until the user's own answer
 * appears (events-out-of-office rule 10).
 */
export function attends(
  e: Pick<ExternalEvent, "selfResponse" | "organizerSelf" | "attendeeCount">,
): boolean {
  if (e.selfResponse === "declined") return false;
  if (e.organizerSelf) return true;
  if (e.selfResponse === "needsAction") return false;
  return e.selfResponse !== null || e.attendeeCount === 0;
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

/** Time away (events-out-of-office.md): busy all-day events and out-of-office events that block. */
export function awayBlocks(events: ExternalEvent[]): Interval[] {
  return events
    .filter((e) => (e.allDay || e.eventType === "outOfOffice") && blocksPlanning(e))
    .map((e) => ({ start: e.start, end: e.end }));
}

const FLIGHT_NUMBER = /\b[A-Z0-9]{2}\s?\d{1,4}\b/;

/** A title with the word "flight" and a flight number (buffers-travel.md rule 2). */
export function isFlightTitle(title: string): boolean {
  return /\bflight\b/i.test(title) && FLIGHT_NUMBER.test(title);
}
