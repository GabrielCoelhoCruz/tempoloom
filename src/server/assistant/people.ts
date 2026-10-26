// People and meetings by chat (docs/specs/assistant-chat.md rules 5, 25, 26;
// edge cases 1, 2, 6): colleagues by name, find time with them, the reporting
// line from directory provisioning, and agendas and prep plans in an event's
// description. Reads see only the caller's team: a colleague outside it is
// outside the organization, so the chat does not read their calendar.
import { z } from "zod";
import type { User } from "../accounts.ts";
import { all, type Db } from "../db.ts";
import { cached, DAY, isoOf, readers, toMs } from "../mcp/reads.ts";
import { type Tool, ToolError, tool } from "../mcp/rpc.ts";
import type { Preview } from "../preview.ts";
import { userFormatsOf, when, zoneOf } from "../preview.ts";
import { membership } from "../teams.ts";

export interface Person {
  name: string;
  email: string;
}

/** The active members of the user's team, without the user. */
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

export interface Reporting {
  manager: Person | null;
  reports: Person[];
}

/**
 * Rule 26: the user's manager and reports from the directory (the manager
 * attribute of admin-sso-provisioning.md rule 8), or null when the directory
 * did not provision the user.
 */
export function reportingOf(db: Db, userId: string): Reporting | null {
  const { team } = membership(db, userId);
  const rows = all<{
    user_id: string;
    external_id: string | null;
    attributes: string;
    name: string;
    email: string;
    deactivated: number;
  }>(
    db,
    `SELECT d.user_id, d.external_id, d.attributes, u.name, u.email, u.deactivated_at IS NOT NULL AS deactivated
     FROM directory_profiles d JOIN users u ON u.id = d.user_id WHERE d.team_id = ?`,
    team.id,
  );
  const me = rows.find((r) => r.user_id === userId);
  if (!me) return null;
  // The manager attribute holds the manager's SCIM id (the user id), external id or email.
  const keys = (r: (typeof rows)[number]) =>
    [r.user_id, r.external_id, r.email].filter((k): k is string => Boolean(k));
  const managerOf = (r: (typeof rows)[number]) =>
    (JSON.parse(r.attributes) as Record<string, string>).manager?.toLowerCase();
  const person = (r: (typeof rows)[number]): Person => ({ name: r.name, email: r.email });
  const wanted = managerOf(me);
  const manager = wanted
    ? rows.find((r) => !r.deactivated && keys(r).some((k) => k.toLowerCase() === wanted))
    : undefined;
  const mine = new Set(keys(me).map((k) => k.toLowerCase()));
  const reports = rows.filter((r) => {
    const m = managerOf(r);
    return r.user_id !== userId && !r.deactivated && m !== undefined && mine.has(m);
  });
  return { manager: manager ? person(manager) : null, reports: reports.map(person) };
}

const datetime = z.iso.datetime({ offset: true });
const instant = z.string().describe("ISO 8601 UTC");
const slot = z.object({ start: instant, end: instant });
/** Closest options and the wider range, at most. */
const OPTIONS = 5;

/** The tools of this file: find_people, find_free_time and propose_event_description. */
export function peopleTools(deps: { db: Db; preview: Preview; now: () => number }): Tool[] {
  const { db, preview, now } = deps;
  const { findFree } = readers(db, now);

  /** Edge case 1: the model looks a colleague up by name and asks when more than one matches. */
  const findPeople = tool({
    name: "find_people",
    effect: "read",
    title: "Find colleagues",
    description:
      "Colleagues in the user's team whose name or email contains the query, with their email. Use it when the user names a person without an email. When more than one person matches, ask the user which one.",
    input: z.object({ query: z.string().trim().min(1).max(200) }),
    output: z.object({ people: z.array(z.object({ name: z.string(), email: z.string() })) }),
    run: ({ user }, a) => {
      const q = a.query.toLowerCase();
      return {
        people: colleagues(db, user.id)
          .filter((p) => p.name.toLowerCase().includes(q) || p.email.includes(q))
          .slice(0, 20)
          .map(({ name, email }) => ({ name, email })),
      };
    },
  });

  /**
   * Rule 5 and edge cases 2, 6: the MCP tool of the same name, with reads only
   * of team members. Others are unknown: the slots use the user's side for them.
   * When no slot fits, the result has the closest options and a wider range.
   */
  const findFreeTime = tool({
    name: "find_free_time",
    effect: "read",
    title: "Find free time",
    description:
      "Free slots of the given length inside the meeting hours of the user and of each attendee who is a colleague in the user's team, where none of them has a busy event. Earliest first. Tempoloom cannot read the calendars of unknown_attendees (outside the user's team): the slots use the user's side only for them. When no slot fits, closest has the user's free slots with the colleagues who are not available then, and wider_range has the slots in the 7 days after the range. Tasks, habits and focus time that Tempoloom plans do not count as busy.",
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
      const team = new Set(colleagues(db, user.id).map((p) => p.email));
      const asked = [...new Set((a.attendees ?? []).map((x) => x.toLowerCase()))].filter(
        (x) => x !== user.email,
      );
      const known = asked.filter((x) => team.has(x));
      const unknown = asked.filter((x) => !team.has(x));
      const base = { duration_minutes: a.duration_minutes, start: a.start, end: a.end };
      const { slots } = findFree(user, { ...base, attendees: known });
      if (slots.length) return { slots, unknown_attendees: unknown };
      const end = a.end ?? isoOf((a.start ? toMs(a.start) : now()) + 7 * DAY);
      const wider = findFree(user, {
        duration_minutes: a.duration_minutes,
        start: end,
        end: isoOf(toMs(end) + 7 * DAY),
        attendees: known,
      }).slots.slice(0, OPTIONS);
      const busyAt = (s: { start: string; end: string }) =>
        known.filter(
          (p) =>
            findFree(user, { ...base, start: s.start, end: s.end, attendees: [p] }).slots.length ===
            0,
        );
      const closest = known.length
        ? findFree(user, base)
            .slots.slice(0, OPTIONS)
            .map((s) => ({ ...s, unavailable: busyAt(s) }))
        : [];
      return { slots, unknown_attendees: unknown, closest, wider_range: wider };
    },
  });

  /** Row 687: an agenda or a prep plan in the description of an event the user organizes. */
  const proposeDescription = tool({
    name: "propose_event_description",
    effect: "stage",
    title: "Propose an agenda or prep plan",
    description:
      "Stages a new description for an event the user organizes (an id from list_events): an agenda, a prep plan, or both. Give the whole new description; keep the parts of the current one (from get_meeting_context) that still apply. Nothing changes and no guest sees it until the user approves and applies it.",
    input: z.object({
      event_id: z.string().min(1),
      description: z.string().trim().min(1).max(10_000),
      reason: z.string().max(1000).optional().describe("Why, in one sentence, shown to the user"),
    }),
    output: z.object({
      id: z.string(),
      state: z.string(),
      summary: z.string(),
      message: z.string(),
    }),
    run: (caller, a) => {
      const ev = organized(caller.user, a.event_id);
      const zone = zoneOf(db, caller.user.id);
      const f = userFormatsOf(db, caller.user.id);
      const s = preview.stage(caller.user.id, {
        source: caller.source ?? "mcp_client",
        client: caller.client,
        kind: "event_update",
        target: a.event_id,
        before: {
          title: ev.summary,
          start: ev.start_ms,
          end: ev.end_ms,
          description: ev.description,
        },
        after: { start: ev.start_ms, end: ev.end_ms, description: a.description },
        impact: [],
        summary: `New description of “${ev.summary}” · ${when(zone, ev.start_ms, ev.end_ms, f)}: ${a.description.length > 120 ? `${a.description.slice(0, 119)}…` : a.description}`,
        reason: a.reason ?? "",
      });
      return {
        id: s.id,
        state: s.state,
        summary: s.summary,
        message:
          "The description is staged in Tempoloom's preview mode. Nothing is written until the user applies it.",
      };
    },
  });

  /** An event of the user's calendars that they organize and may change. */
  function organized(user: User, id: string) {
    const ev = cached(db, user.id, id);
    if (!ev) throw new ToolError(`No event ${id} on your calendars`);
    if ((JSON.parse(ev.private_props) as Record<string, string>).tl === "1")
      throw new ToolError("Tempoloom plans this event; it has no agenda to change");
    if (!ev.writable) throw new ToolError("This calendar is read-only");
    if (!ev.organizer_self)
      throw new ToolError(
        "You do not organize this event, so Tempoloom cannot change its description.",
      );
    return ev;
  }

  return [findPeople, findFreeTime, proposeDescription];
}
