// People by chat (docs/specs/assistant-chat.md rules 5, 25, 26; edge cases 1,
// 2, 6): colleagues by name, time with them, and the reporting line from
// directory provisioning. These reads see only the caller's team: a person
// outside it is outside the organization, so the chat does not read their
// calendar and does not name them in the prompt.
import { z } from "zod";
import { all, type Db } from "../db.ts";
import { managerLookup, type ProfileKeys } from "../directory.ts";
import { DAY, isoOf, readers, slotsOf } from "../mcp/reads.ts";
import { type Tool, tool } from "../mcp/rpc.ts";
import { membership } from "../teams.ts";

export interface Person {
  name: string;
  email: string;
}

/** Active members of the user's team, without the user. */
function colleagues(db: Db, userId: string): (Person & { id: string })[] {
  const { team } = membership(db, userId);
  return all<Person & { id: string }>(
    db,
    `SELECT u.id, u.name, u.email FROM team_members m JOIN users u ON u.id = m.user_id
     WHERE m.team_id = ? AND u.id <> ? AND u.deactivated_at IS NULL ORDER BY u.name, u.email`,
    team.id,
    userId,
  );
}

/** Reports in the prompt, at most; reports_total gives the count. */
export const MAX_PROMPT_REPORTS = 50;

export interface Reporting {
  manager: Person | null;
  reports: Person[];
  reports_total: number;
}

/**
 * Rule 26: the user's manager and reports from the directory's manager
 * attribute (directory.ts managerLookup, the rule analytics uses too), among
 * people who are still active members of the user's team. Null when the
 * directory did not provision the user.
 */
export function reportingOf(db: Db, userId: string): Reporting | null {
  const { team } = membership(db, userId);
  const rows = all<ProfileKeys & Person & { attributes: string }>(
    db,
    `SELECT d.user_id, d.external_id, d.attributes, u.name, u.email FROM directory_profiles d
     JOIN users u ON u.id = d.user_id
     JOIN team_members m ON m.user_id = d.user_id AND m.team_id = d.team_id
     WHERE d.team_id = ? AND u.deactivated_at IS NULL ORDER BY u.name, u.email`,
    team.id,
  );
  const me = rows.find((r) => r.user_id === userId);
  if (!me) return null;
  const lookup = managerLookup(rows);
  const managerOf = (r: (typeof rows)[number]) => {
    const m = (JSON.parse(r.attributes) as Record<string, string>).manager;
    return m ? lookup(m) : undefined;
  };
  const person = (r: Person): Person => ({ name: r.name, email: r.email });
  const manager = managerOf(me);
  const reports = rows.filter((r) => r.user_id !== userId && managerOf(r)?.user_id === userId);
  return {
    manager: manager && manager.user_id !== userId ? person(manager) : null,
    reports: reports.slice(0, MAX_PROMPT_REPORTS).map(person),
    reports_total: reports.length,
  };
}

const datetime = z.iso.datetime({ offset: true });
const instant = z.string().describe("ISO 8601 UTC");
const slot = z.object({ start: instant, end: instant });
/** Closest options and wider-range slots, at most. */
const OPTIONS = 5;
const AMBIGUOUS =
  "More than one person matches. Ask the user which one they mean, and stage nothing until they answer.";

/** The tools of this file: find_people and find_meeting_time. */
export function peopleTools(deps: { db: Db; now: () => number }): Tool[] {
  const { db, now } = deps;
  const { availability, searchRange } = readers(db, now);

  /** Edge case 1: a colleague by name; with more than one match the result tells the model to ask. */
  const findPeople = tool({
    name: "find_people",
    effect: "read",
    title: "Find colleagues",
    description:
      "Colleagues in the user's team whose name, or the part of the email before @, contains the query, with their email. Use it when the user names a person without an email.",
    input: z.object({ query: z.string().trim().min(1).max(200) }),
    output: z.object({
      people: z.array(z.object({ name: z.string(), email: z.string() })),
      note: z.string().optional(),
    }),
    run: ({ user }, a) => {
      const q = a.query.toLowerCase();
      const people = colleagues(db, user.id)
        .filter(
          (p) => p.name.toLowerCase().includes(q) || (p.email.split("@")[0] ?? "").includes(q),
        )
        .slice(0, 20)
        .map(({ name, email }) => ({ name, email }));
      return people.length > 1 ? { people, note: AMBIGUOUS } : { people };
    },
  });

  /**
   * Rule 5 and edge cases 2, 6: time with colleagues of the user's team, by
   * their meeting hours and busy events. Other guests' calendars are not read.
   * When no slot fits: the user's free slots ranked by the fewest colleagues
   * who are not available, and the slots of the next 7 days.
   */
  const findMeetingTime = tool({
    name: "find_meeting_time",
    effect: "read",
    title: "Find time with colleagues",
    description:
      "Free slots of the given length inside the meeting hours of the user and of each attendee who is a colleague in the user's team, where none of them has a busy event. Earliest first. Tempoloom does not read the calendars of unknown_attendees (outside the user's team) or of deactivated_attendees: the slots use the user's side only for them. When no slot fits, closest has the user's free slots with the colleagues who are not available then (fewest first), and wider_range has the slots of the 7 days after the range. Tasks, habits and focus time that Tempoloom plans do not count as busy. Without attendees it finds the user's own free time.",
    input: z.object({
      duration_minutes: z.number().int().min(15).max(480),
      start: datetime.optional().describe("Default: now"),
      end: datetime.optional().describe("Default: 7 days after start; at most 31 days"),
      attendees: z.array(z.email()).max(20).optional(),
    }),
    output: z.object({
      slots: z.array(slot),
      unknown_attendees: z
        .array(z.string())
        .describe("Guests outside the user's team: their calendars are not read"),
      deactivated_attendees: z
        .array(z.string())
        .describe("Guests whose account here is deactivated: their calendars are not read"),
      closest: z
        .array(slot.extend({ unavailable: z.array(z.string()) }))
        .optional()
        .describe("Only when no slot fits: the user's free slots and who is not available"),
      wider_range: z
        .array(slot)
        .optional()
        .describe("Only when no slot fits: slots in the 7 days after the range"),
    }),
    run: ({ user }, a) => {
      const team = new Map(colleagues(db, user.id).map((p) => [p.email, p.id]));
      const asked = [...new Set((a.attendees ?? []).map((x) => x.toLowerCase()))].filter(
        (x) => x !== user.email,
      );
      const deactivated = new Set(
        asked.length
          ? all<{ email: string }>(
              db,
              `SELECT email FROM users WHERE deactivated_at IS NOT NULL
               AND email IN (${asked.map(() => "?").join(",")})`,
              ...asked,
            ).map((r) => r.email)
          : [],
      );
      const known = asked.filter((x) => team.has(x));
      const out = {
        unknown_attendees: asked.filter((x) => !team.has(x) && !deactivated.has(x)),
        deactivated_attendees: asked.filter((x) => deactivated.has(x)),
      };
      const length = a.duration_minutes * 60_000;
      const iso = (s: { start: number; end: number }) => ({
        start: isoOf(s.start),
        end: isoOf(s.end),
      });
      // One availability read per person and range.
      const together = (from: number, to: number) => {
        const theirs = known.map(
          (e) => [e, availability(team.get(e) as string, from, to)] as const,
        );
        let free = availability(user.id, from, to);
        for (const [, t] of theirs) free = free.intersect(t);
        return { free, theirs };
      };
      const { from, to } = searchRange(a.start, a.end);
      if (to <= from) return { slots: [], ...out };
      const { free, theirs } = together(from, to);
      const slots = slotsOf(free, length);
      if (slots.length) return { slots: slots.map(iso), ...out };
      const closest = known.length
        ? slotsOf(availability(user.id, from, to), length)
            .map((s) => ({
              ...s,
              unavailable: theirs.filter(([, t]) => !t.contains(s)).map(([e]) => e),
            }))
            .sort((x, y) => x.unavailable.length - y.unavailable.length || x.start - y.start)
            .slice(0, OPTIONS)
            .map((s) => ({ ...iso(s), unavailable: s.unavailable }))
        : [];
      const wider = slotsOf(together(to, to + 7 * DAY).free, length, OPTIONS).map(iso);
      return { slots: [], ...out, closest, wider_range: wider };
    },
  });

  return [findPeople, findMeetingTime];
}
