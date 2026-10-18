// Event categories (docs/specs/events-categories-and-colors.md rules 1-5).
import { isFlightTitle } from "./blocking.ts";

export const CATEGORIES = [
  "team_meeting",
  "one_on_one",
  "external_meeting",
  "solo_work",
  "personal",
  "travel",
  "flight",
  "vacation",
  "personal_commitment",
] as const;
export type Category = (typeof CATEGORIES)[number];

export interface CategoryInput {
  title: string;
  description: string;
  start: number;
  end: number;
  eventType: string;
  /** Attendee emails, the user's own included or not. */
  attendees: string[];
  /** The kind of a managed event, or null for an external event. */
  managedKind: string | null;
  /** A habit in personal hours. */
  personalHabit?: boolean;
  /** A travel or airport buffer. */
  travelBuffer?: boolean;
  /** The event comes from a calendar marked personal (mirroring). */
  personalCalendar: boolean;
  /** A category the user set on this event. */
  manual: Category | null;
}

const PERSONAL = ["doctor", "dentist", "gym", "school", "pickup", "birthday", "family"];
const TRAVEL = ["commute", "drive", "ride", "transit"];
const EIGHT_HOURS = 8 * 3_600_000;

const hasWord = (text: string, words: string[]) =>
  words.some((w) => new RegExp(`\\b${w}\\b`, "i").test(text));
const domainOf = (email: string) => email.slice(email.lastIndexOf("@") + 1).toLowerCase();

/** The first rule that matches decides (rule 1). `userEmail` gives the login domain. */
export function categoryOf(e: CategoryInput, userEmail: string): Category {
  if (e.manual) return e.manual;
  const text = `${e.title}\n${e.description}`;
  if (/#tl_flight\b/i.test(text)) return "flight";
  if (/#tl_trip\b/i.test(text)) return "travel";
  if (e.eventType === "outOfOffice")
    return e.end - e.start > EIGHT_HOURS ? "vacation" : "personal_commitment";
  if (!e.managedKind && isFlightTitle(e.title)) return "flight";
  const self = userEmail.toLowerCase();
  const others = e.attendees.map((a) => a.toLowerCase()).filter((a) => a !== self);
  const byPeople = (): Category => {
    const domain = domainOf(self);
    if (others.some((a) => domainOf(a) !== domain)) return "external_meeting";
    if (others.length === 1) return "one_on_one";
    if (others.length >= 2) return "team_meeting";
    return "solo_work";
  };
  if (e.managedKind) {
    if (e.managedKind === "meeting") return byPeople();
    if (e.managedKind === "habit") return e.personalHabit ? "personal" : "solo_work";
    if (e.managedKind === "buffer") return e.travelBuffer ? "travel" : "solo_work";
    if (e.managedKind === "mirror") return e.personalCalendar ? "personal" : "solo_work";
    return "solo_work";
  }
  if (e.personalCalendar || hasWord(text, PERSONAL)) return "personal";
  if (hasWord(text, TRAVEL)) return "travel";
  return byPeople();
}
