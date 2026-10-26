// People and meetings by chat (src/server/assistant/people.ts) on an in-memory
// database.
//
// Ways it can fail:
// 1. The reporting line misses a manager given by email or external id, keeps a
//    deactivated manager, or exists for a user the directory did not provision.
// 2. find_free_time reads the calendar of a person outside the team.
// 3. find_people lists people outside the team or deactivated people.
// 4. An agenda is staged for an event the user does not organize, or applies
//    over a description that changed after staging.
// 5. save_memory proposes past the memory limit.
import { describe, expect, it } from "vitest";
import { ensureUser, type User } from "../../src/server/accounts.ts";
import { reportingOf } from "../../src/server/assistant/people.ts";
import { chatTools } from "../../src/server/assistant/tools.ts";
import { type Db, openDb, run } from "../../src/server/db.ts";
import { setInstanceLimit } from "../../src/server/limits.ts";
import { callTool } from "../../src/server/mcp/rpc.ts";
import { createPreview, type PreviewDeps } from "../../src/server/preview.ts";
import { membership } from "../../src/server/teams.ts";

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
    profile(db, user.id, team, { manager: "EXT-BOSS" });
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
    });
    expect(reportingOf(db, user.id)?.reports).toHaveLength(2);
    run(db, "UPDATE users SET deactivated_at = ? WHERE id = ?", T0, boss.id);
    expect(reportingOf(db, user.id)?.manager).toBeNull();
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
    const r = await call("find_free_time", {
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

    const people = await call("find_people", { query: "alex" });
    expect((people as unknown as { data: { people: { email: string }[] } }).data.people).toEqual([
      { name: "Alex Mate", email: "mate@example.com" },
    ]);
    run(db, "UPDATE users SET deactivated_at = ? WHERE id = ?", T0, mate.id);
    const none = await call("find_people", { query: "alex" });
    expect((none as unknown as { data: { people: unknown[] } }).data.people).toEqual([]);
  });
});

describe("agenda by chat", () => {
  it("stages only for events the user organizes and applies only over the description it saw", async () => {
    const { db, user, call, preview, writes } = setup();
    calendar(db, user, "c1");
    event(db, "c1", "mine", T0 + 26 * HOUR, T0 + 27 * HOUR);
    event(db, "c1", "theirs", T0 + 28 * HOUR, T0 + 29 * HOUR, 0);
    const refused = await call("propose_event_description", {
      event_id: "ext:c1:theirs",
      description: "Agenda",
    });
    expect(refused).toMatchObject({ isError: true });
    const staged = await call("propose_event_description", {
      event_id: "ext:c1:mine",
      description: "Room 4\nAgenda: numbers",
    });
    const id = (staged as unknown as { data: { id: string } }).data.id;
    run(db, "UPDATE events SET description = 'Room 5' WHERE event_id = 'mine'");
    run(db, "UPDATE staged_changes SET state = 'accepted' WHERE id = ?", id);
    const stale = await preview.apply(user.id, [id]);
    expect(stale.stale.map((s) => s.id)).toEqual([id]);
    expect(writes).toEqual([]);

    const again = await call("propose_event_description", {
      event_id: "ext:c1:mine",
      description: "Room 5\nAgenda: numbers",
    });
    const id2 = (again as unknown as { data: { id: string } }).data.id;
    run(db, "UPDATE staged_changes SET state = 'accepted' WHERE id = ?", id2);
    const done = await preview.apply(user.id, [id2]);
    expect(done).toMatchObject({ failed: [], stale: [] });
    expect(done.applied.map((s) => s.id)).toEqual([id2]);
    expect(writes).toEqual([
      expect.objectContaining({ description: "Room 5\nAgenda: numbers", start: T0 + 26 * HOUR }),
    ]);
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
});
