// People and meetings by chat (src/server/assistant/people.ts) on an in-memory
// database.
//
// Ways it can fail:
// 1. The reporting line misses a manager given by email or external id, keeps a
//    deactivated manager, or exists for a user the directory did not provision.
// 2. find_free_time reads the calendar of a person outside the team.
// 3. find_people lists people outside the team or deactivated people.
// 4. An agenda is staged for an event the user does not organize, applies over
//    a description that changed after staging, or sends an unchanged start and
//    end (an all-day event turns timed); a move and an agenda are two changes.
// 6. "closest" is the earliest slots instead of the fewest busy colleagues.
// 5. save_memory proposes past the memory limit.
import { describe, expect, it } from "vitest";
import { ensureUser, type User } from "../../src/server/accounts.ts";
import { MAX_PROMPT_REPORTS, reportingOf } from "../../src/server/assistant/people.ts";
import { memories, proposeMemory, saveMemory } from "../../src/server/assistant/store.ts";
import { chatTools } from "../../src/server/assistant/tools.ts";
import { all, type Db, openDb, run } from "../../src/server/db.ts";
import { setInstanceLimit } from "../../src/server/limits.ts";
import { callTool } from "../../src/server/mcp/rpc.ts";
import { createPreview, type PreviewDeps } from "../../src/server/preview.ts";
import { createOwnTeam, membership } from "../../src/server/teams.ts";

const T0 = Date.parse("2026-10-19T06:00:00Z");
const HOUR = 3_600_000;

function setup() {
  const db = openDb(":memory:");
  const now = () => T0;
  const user = ensureUser(db, "owner@example.com", "Owner", T0) as User;
  const team = membership(db, user.id).team.id;
  const writes: unknown[] = [];
  const provider = {
    editExternal: async (_c: string, id: string, change: { description?: string }) => {
      writes.push(change);
      return {
        id,
        cancelled: false,
        etag: null,
        summary: "Sync",
        description: change.description ?? "",
        location: "",
        start: T0 + 26 * HOUR,
        end: T0 + 27 * HOUR,
        allDay: false,
        busy: true,
        eventType: "default",
        selfResponse: null,
        attendeeCount: 0,
        attendees: [],
        organizerSelf: true,
        recurringId: null,
        colorId: null,
        updated: null,
        privateProps: {},
        visibility: "default",
      };
    },
  };
  const preview = createPreview({
    db,
    sync: {
      runNow: async () => {},
      idle: async () => {},
      request: () => {},
      exclusive: (_u: string, f: (pool: unknown) => unknown) => f({ get: () => provider }),
    },
    mailer: {},
    live: { notify: () => {} },
    now,
    app: () => null,
    dry: () => null,
  } as unknown as PreviewDeps);
  const tools = chatTools({ db, preview, baseUrl: "http://localhost:3000", now });
  const call = async (name: string, args: Record<string, unknown>, who: User = user) => {
    const t = tools.find((x) => x.tool.name === name);
    if (!t) throw new Error(`no tool ${name}`);
    return callTool(t.tool, { user: who, client: "", source: "assistant_chat" }, args);
  };
  return { db, user, team, preview, call, writes };
}

function profile(
  db: Db,
  userId: string,
  team: string,
  attrs: Record<string, string>,
  ext?: string,
) {
  run(
    db,
    `INSERT INTO directory_profiles (user_id, team_id, external_id, resource, attributes, created_at, updated_at)
     VALUES (?, ?, ?, '{}', ?, ?, ?)`,
    userId,
    team,
    ext ?? null,
    JSON.stringify(attrs),
    T0,
    T0,
  );
}

function calendar(db: Db, user: User, id: string) {
  run(
    db,
    "INSERT INTO accounts (id, user_id, provider, external_id, email, credentials, created_at) VALUES (?, ?, 'caldav', ?, ?, '{}', ?)",
    `a-${id}`,
    user.id,
    id,
    user.email,
    T0,
  );
  run(
    db,
    "INSERT INTO calendars (id, account_id, provider_id, name, writable, is_primary, check_availability) VALUES (?, ?, 'p', 'Work', 1, 1, 1)",
    id,
    `a-${id}`,
  );
}

function event(db: Db, cal: string, id: string, start: number, end: number, organizer = 1) {
  run(
    db,
    `INSERT INTO events (calendar_id, event_id, summary, description, start_ms, end_ms, attendees, attendee_count, organizer_self)
     VALUES (?, ?, 'Sync', 'Room 4', ?, ?, '[]', 0, ?)`,
    cal,
    id,
    start,
    end,
    organizer,
  );
}

describe("reporting line", () => {
  it("resolves the manager by id, email or external id, and the reports; none without a profile", () => {
    const { db, user, team } = setup();
    expect(reportingOf(db, user.id)).toBeNull();
    const boss = ensureUser(db, "boss@example.com", "Boss", T0, team);
    const gone = ensureUser(db, "gone@example.com", "Gone", T0, team);
    const ana = ensureUser(db, "ana@example.com", "Ana", T0, team);
    const rui = ensureUser(db, "rui@example.com", "Rui", T0, team);
    profile(db, boss.id, team, {}, "ext-boss");
    profile(db, user.id, team, { manager: "ext-boss" });
    profile(db, ana.id, team, { manager: user.id });
    profile(db, rui.id, team, { manager: "owner@example.com" });
    profile(db, gone.id, team, { manager: user.id });
    run(db, "UPDATE users SET deactivated_at = ? WHERE id = ?", T0, gone.id);
    expect(reportingOf(db, user.id)).toEqual({
      manager: { name: "Boss", email: "boss@example.com" },
      reports: expect.arrayContaining([
        { name: "Ana", email: "ana@example.com" },
        { name: "Rui", email: "rui@example.com" },
      ]),
      reports_total: 2,
    });
    expect(reportingOf(db, user.id)?.reports).toHaveLength(2);
    expect(reportingOf(db, user.id)?.reports_total).toBe(2);
    run(db, "UPDATE users SET deactivated_at = ? WHERE id = ?", T0, boss.id);
    expect(reportingOf(db, user.id)?.manager).toBeNull();
  });

  it("does not name a person who left the team, though their profile row stays", () => {
    const { db, user, team } = setup();
    const ana = ensureUser(db, "ana@example.com", "Ana", T0, team);
    profile(db, user.id, team, {});
    profile(db, ana.id, team, { manager: user.id });
    expect(reportingOf(db, user.id)?.reports).toEqual([{ name: "Ana", email: "ana@example.com" }]);
    // Ana leaves for a team of her own; directory_profiles keeps the old team id.
    run(db, "DELETE FROM team_members WHERE user_id = ?", ana.id);
    createOwnTeam(db, ana, T0);
    expect(reportingOf(db, user.id)).toEqual({ manager: null, reports: [], reports_total: 0 });
  });

  it("caps the reports in the prompt and gives the total", () => {
    const { db, user, team } = setup();
    profile(db, user.id, team, {});
    for (let i = 0; i < MAX_PROMPT_REPORTS + 3; i++) {
      const r = ensureUser(db, `r${i}@example.com`, `R${i}`, T0, team);
      profile(db, r.id, team, { manager: "owner@example.com" });
    }
    const line = reportingOf(db, user.id);
    expect(line?.reports).toHaveLength(MAX_PROMPT_REPORTS);
    expect(line?.reports_total).toBe(MAX_PROMPT_REPORTS + 3);
  });
});

describe("find time and people", () => {
  it("reads team members only; others are unknown and their calendars are not read", async () => {
    const { db, team, call } = setup();
    const mate = ensureUser(db, "mate@example.com", "Alex Mate", T0, team);
    const out = ensureUser(db, "alex@elsewhere.example", "Alex Out", T0);
    calendar(db, mate, "cm");
    calendar(db, out, "co");
    const day = Date.parse("2026-10-20T09:00:00Z"); // Tuesday 09:00 in the user's zone (UTC)
    event(db, "cm", "m1", day, day + HOUR);
    event(db, "co", "o1", day + HOUR, day + 8 * HOUR);
    const r = await call("find_meeting_time", {
      duration_minutes: 30,
      start: "2026-10-20T00:00:00Z",
      end: "2026-10-21T00:00:00Z",
      attendees: ["mate@example.com", "alex@elsewhere.example"],
    });
    expect(r.isError).toBe(false);
    const data = (
      r as unknown as { data: { slots: { start: string }[]; unknown_attendees: string[] } }
    ).data;
    expect(data.unknown_attendees).toEqual(["alex@elsewhere.example"]);
    expect(data.slots[0]?.start).toBe(new Date(day + HOUR).toISOString());

    // A name matches; a domain does not match everyone.
    const people = await call("find_people", { query: "alex" });
    expect((people as unknown as { data: { people: { email: string }[] } }).data.people).toEqual([
      { name: "Alex Mate", email: "mate@example.com" },
    ]);
    const domain = await call("find_people", { query: "example" });
    expect((domain as unknown as { data: { people: unknown[] } }).data.people).toEqual([]);
    // A deactivated colleague is neither found nor called outside the team.
    run(db, "UPDATE users SET deactivated_at = ? WHERE id = ?", T0, mate.id);
    const none = await call("find_people", { query: "alex" });
    expect((none as unknown as { data: { people: unknown[] } }).data.people).toEqual([]);
    const gone = await call("find_meeting_time", {
      duration_minutes: 30,
      start: "2026-10-20T00:00:00Z",
      end: "2026-10-21T00:00:00Z",
      attendees: ["mate@example.com"],
    });
    expect((gone as unknown as { data: Record<string, unknown> }).data).toMatchObject({
      unknown_attendees: [],
      deactivated_attendees: ["mate@example.com"],
    });
  });

  it("two matches carry the note to ask", async () => {
    const { db, team, call } = setup();
    ensureUser(db, "alex.a@example.com", "Alex A", T0, team);
    ensureUser(db, "alex.b@example.com", "Alex B", T0, team);
    const r = (await call("find_people", { query: "alex" })) as unknown as {
      data: { people: unknown[]; note?: string };
    };
    expect(r.data.people).toHaveLength(2);
    expect(r.data.note).toContain("Ask the user which one");
  });

  it("with no common slot, closest ranks the fewest busy colleagues first, then the time", async () => {
    const { db, team, call } = setup();
    const a = ensureUser(db, "a@example.com", "A", T0, team);
    const b = ensureUser(db, "b@example.com", "B", T0, team);
    calendar(db, a, "ca");
    calendar(db, b, "cb");
    const nine = Date.parse("2026-10-20T09:00:00Z");
    // A is busy all day; B is busy until 15:00. So no common slot; at 15:00 only A is busy.
    event(db, "ca", "a1", nine, nine + 8 * HOUR);
    event(db, "cb", "b1", nine, nine + 6 * HOUR);
    const r = (await call("find_meeting_time", {
      duration_minutes: 60,
      start: "2026-10-20T00:00:00Z",
      end: "2026-10-21T00:00:00Z",
      attendees: ["a@example.com", "b@example.com"],
    })) as unknown as {
      data: {
        slots: unknown[];
        closest: { start: string; unavailable: string[] }[];
        wider_range: { start: string }[];
      };
    };
    expect(r.data.slots).toEqual([]);
    expect(r.data.closest[0]).toEqual({
      start: new Date(nine + 6 * HOUR).toISOString(),
      end: new Date(nine + 7 * HOUR).toISOString(),
      unavailable: ["a@example.com"],
    });
    expect(r.data.closest[1]?.start).toBe(new Date(nine + 6.5 * HOUR).toISOString());
    expect(r.data.closest.at(-1)?.unavailable).toEqual(["a@example.com", "b@example.com"]);
    expect(r.data.wider_range[0]?.start).toBe("2026-10-21T09:00:00.000Z");
  });

  it("closest ranks every free slot of the range, so a better slot on a later day wins", async () => {
    const { db, team, call } = setup();
    const a = ensureUser(db, "a@example.com", "A", T0, team);
    const b = ensureUser(db, "b@example.com", "B", T0, team);
    calendar(db, a, "ca");
    calendar(db, b, "cb");
    const tue9 = Date.parse("2026-10-20T09:00:00Z");
    const thu15 = Date.parse("2026-10-22T15:00:00Z");
    const fri17 = Date.parse("2026-10-23T17:00:00Z");
    // B is busy all the time; A is free only on Thursday 15:00-16:00, past the first 20 slots.
    event(db, "cb", "b1", tue9, fri17);
    event(db, "ca", "a1", tue9, thu15);
    event(db, "ca", "a2", thu15 + HOUR, fri17);
    const r = (await call("find_meeting_time", {
      duration_minutes: 60,
      start: "2026-10-20T00:00:00Z",
      end: "2026-10-24T00:00:00Z",
      attendees: ["a@example.com", "b@example.com"],
    })) as unknown as { data: { closest: { start: string; unavailable: string[] }[] } };
    expect(r.data.closest[0]).toMatchObject({
      start: new Date(thu15).toISOString(),
      unavailable: ["b@example.com"],
    });
  });

  it("names a deactivated person of the team as deactivated, and one of another team as unknown", async () => {
    const { db, team, call } = setup();
    const left = ensureUser(db, "left@example.com", "Left", T0, team);
    profile(db, left.id, team, {});
    // Deactivation takes a member out of the team; the directory profile keeps it.
    run(db, "DELETE FROM team_members WHERE user_id = ?", left.id);
    run(db, "UPDATE users SET deactivated_at = ? WHERE id = ?", T0, left.id);
    const other = ensureUser(db, "other@elsewhere.example", "Other", T0);
    run(db, "UPDATE users SET deactivated_at = ? WHERE id = ?", T0, other.id);
    const r = (await call("find_meeting_time", {
      duration_minutes: 30,
      attendees: ["left@example.com", "other@elsewhere.example"],
    })) as unknown as { data: { unknown_attendees: string[]; deactivated_attendees: string[] } };
    expect(r.data.deactivated_attendees).toEqual(["left@example.com"]);
    expect(r.data.unknown_attendees).toEqual(["other@elsewhere.example"]);
  });
});

describe("agenda by propose_update_event", () => {
  it("stages only for events the user organizes, sends only the description, and applies only over the description it saw", async () => {
    const { db, user, call, preview, writes } = setup();
    calendar(db, user, "c1");
    event(db, "c1", "mine", T0 + 26 * HOUR, T0 + 27 * HOUR);
    event(db, "c1", "theirs", T0 + 28 * HOUR, T0 + 29 * HOUR, 0);
    const refused = await call("propose_update_event", {
      event_id: "ext:c1:theirs",
      description: "Agenda",
    });
    expect(refused).toMatchObject({ isError: true });
    const staged = await call("propose_update_event", {
      event_id: "ext:c1:mine",
      description: "Room 4\nAgenda: numbers",
    });
    const id = (staged as unknown as { data: { id: string } }).data.id;
    run(db, "UPDATE events SET description = 'Room 5' WHERE event_id = 'mine'");
    run(db, "UPDATE staged_changes SET state = 'accepted' WHERE id = ?", id);
    const stale = await preview.apply(user.id, [id]);
    expect(stale.stale.map((s) => s.id)).toEqual([id]);
    expect(writes).toEqual([]);

    const again = await call("propose_update_event", {
      event_id: "ext:c1:mine",
      description: "Room 5\nAgenda: numbers",
    });
    const id2 = (again as unknown as { data: { id: string } }).data.id;
    run(db, "UPDATE staged_changes SET state = 'accepted' WHERE id = ?", id2);
    const done = await preview.apply(user.id, [id2]);
    expect(done).toMatchObject({ failed: [], stale: [] });
    expect(done.applied.map((s) => s.id)).toEqual([id2]);
    // No start or end: an all-day event stays all-day and no guest is asked again.
    expect(writes).toEqual([{ description: "Room 5\nAgenda: numbers" }]);
  });

  it("a rename sends only the title; a move and an agenda are one change that sends both", async () => {
    const { db, user, call, preview, writes } = setup();
    calendar(db, user, "c1");
    event(db, "c1", "mine", T0 + 26 * HOUR, T0 + 27 * HOUR);
    const apply = async (args: Record<string, unknown>) => {
      const r = await call("propose_update_event", { event_id: "ext:c1:mine", ...args });
      const id = (r as unknown as { data: { id: string } }).data.id;
      run(db, "UPDATE staged_changes SET state = 'accepted' WHERE id = ?", id);
      return preview.apply(user.id, [id]);
    };
    await apply({ title: "Sync 2" });
    expect(writes).toEqual([{ summary: "Sync 2" }]);
    writes.length = 0;
    run(db, "UPDATE events SET summary = 'Sync' WHERE event_id = 'mine'");
    const start = new Date(T0 + 30 * HOUR).toISOString();
    const end = new Date(T0 + 31 * HOUR).toISOString();
    const r = await call("propose_update_event", { event_id: "ext:c1:mine", start, end });
    const both = await call("propose_update_event", {
      event_id: "ext:c1:mine",
      start,
      end,
      description: "Agenda",
    });
    const open = all<{ id: string }>(
      db,
      "SELECT id FROM staged_changes WHERE state IN ('pending', 'accepted')",
    );
    expect(open.map((o) => o.id)).toEqual([(both as unknown as { data: { id: string } }).data.id]);
    expect(r.isError).toBe(false);
    run(db, "UPDATE staged_changes SET state = 'accepted' WHERE state = 'pending'");
    await preview.apply(user.id, [open[0]?.id ?? ""]);
    expect(writes).toEqual([{ start: T0 + 30 * HOUR, end: T0 + 31 * HOUR, description: "Agenda" }]);
  });

  it("refuses a move of an all-day event, a change that changes nothing and an empty description", async () => {
    const { db, user, call } = setup();
    calendar(db, user, "c1");
    const day = Date.parse("2026-10-22T00:00:00Z");
    event(db, "c1", "offsite", day, day + 24 * HOUR);
    event(db, "c1", "sync", T0 + 26 * HOUR, T0 + 27 * HOUR);
    run(db, "UPDATE events SET all_day = 1 WHERE event_id = 'offsite'");
    const move = await call("propose_update_event", {
      event_id: "ext:c1:offsite",
      start: "2026-10-23T09:00:00Z",
      end: "2026-10-23T10:00:00Z",
    });
    expect(move).toMatchObject({
      isError: true,
      text: expect.stringContaining("cannot move all-day events"),
    });
    const agenda = await call("propose_update_event", {
      event_id: "ext:c1:offsite",
      description: "Agenda",
    });
    expect((agenda as unknown as { data: { summary: string } }).data.summary).toBe(
      "New description for “Sync” · Thu 2026-10-22 (all day)",
    );
    for (const args of [{ title: "Sync" }, { description: "Room 4" }, {}]) {
      const same = await call("propose_update_event", { event_id: "ext:c1:sync", ...args });
      expect(same).toMatchObject({
        isError: true,
        text: expect.stringContaining("Nothing changes"),
      });
    }
    const empty = await call("propose_update_event", { event_id: "ext:c1:sync", description: " " });
    expect(empty).toMatchObject({ isError: true });
    const rename = await call("propose_update_event", { event_id: "ext:c1:sync", title: "Sync 2" });
    expect((rename as unknown as { data: { summary: string } }).data.summary).toMatch(
      /^Rename “Sync” to “Sync 2” · /,
    );
    // Only the agenda and the rename are staged (one change per event: the rename replaced nothing else).
    const open = all<{ target: string }>(
      db,
      "SELECT target FROM staged_changes WHERE state = 'pending' ORDER BY target",
    );
    expect(open.map((o) => o.target)).toEqual(["ext:c1:offsite", "ext:c1:sync"]);
  });
});

describe("memory limit", () => {
  it("save_memory refuses past the limit and names it", async () => {
    const { db, call } = setup();
    setInstanceLimit(db, "max_chat_memories", 1);
    const first = await call("save_memory", { text: "No meetings on Friday" });
    expect(first.isError).toBe(false);
    run(db, "UPDATE assistant_memories SET state = 'saved'");
    const second = await call("save_memory", { text: "Mornings for focus" });
    expect(second).toMatchObject({
      isError: true,
      text: expect.stringContaining("This server allows at most 1 chat memory per person."),
    });
  });

  it("Save checks the count and saves in one step", () => {
    const { db, user } = setup();
    const a = proposeMemory(db, user.id, "A", [], T0);
    const b = proposeMemory(db, user.id, "B", [], T0);
    expect(saveMemory(db, user.id, a.id, T0, 1)).toBe("saved");
    expect(saveMemory(db, user.id, b.id, T0, 1)).toBe("limit");
    expect(saveMemory(db, user.id, "nope", T0, 1)).toBe("missing");
    expect(memories(db, user.id).map((m) => m.text)).toEqual(["A"]);
    expect(saveMemory(db, user.id, b.id, T0, null)).toBe("saved");
  });
});
