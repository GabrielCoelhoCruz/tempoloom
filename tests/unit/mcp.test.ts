// The MCP server's tool contract (docs/specs/assistant-mcp-server.md). The E2E
// suite drives the server against a real calendar; these tests check the parts
// a generic MCP client reads before it calls a tool: the annotations, the output
// schemas and the pages of the list tools.
//
// Ways it can fail:
// 1. A tool that deletes events (apply_staged_changes runs staged deletes) says
//    it is not destructive, so a client runs it without asking the user.
// 2. A read tool does not say it is read-only and idempotent.
// 3. A tool has no outputSchema, or its structuredContent does not match it.
// 4. A list tool returns every row in one response.
// 5. Two pages skip or repeat a row, also when a row is added between the calls.
// 6. A bad cursor, a cursor of another list or filter, or a limit above the
//    maximum is accepted.
// 7. A tool's run returns a key or a type that its outputSchema does not have,
//    and tools/call sends it on as structuredContent.
// 8. list_automations pages in another order than the automation list.
// 10. A write tool fails after it staged or applied a change and says only
//    "failed": the client retries and stages a duplicate, or tells the user
//    nothing changed while the calendar did.
// 9. list_staged_changes pages in another order than the preview panel
//    (openChanges): oldest first, and in staging order at one created_at.
import { Ajv2020 } from "ajv/dist/2020.js";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureUser } from "../../src/server/accounts.ts";
import { listAutomations } from "../../src/server/api/automations.ts";
import * as stats from "../../src/server/api/stats.ts";
import { createApiKey } from "../../src/server/api-keys.ts";
import type { AppEnv } from "../../src/server/app.ts";
import { all, one, openDb, run } from "../../src/server/db.ts";
import { mcpRoutes } from "../../src/server/mcp.ts";
import { CHECK_IDS } from "../../src/server/meeting-prefs.ts";
import { createPreview, openChanges, type PreviewDeps } from "../../src/server/preview.ts";

// get_stats returns computeStats as is: a test can make it return a bad result.
vi.mock(import("../../src/server/api/stats.ts"), async (original) => {
  const real = await original();
  return { ...real, computeStats: vi.fn(real.computeStats) };
});
afterEach(() => vi.mocked(stats.computeStats).mockClear());

const T0 = Date.parse("2026-10-19T08:00:00Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const GUEST = "guest@example.com";

interface Rpc {
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}
interface ToolResult {
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}
interface ListedTool {
  name: string;
  annotations: Record<string, boolean>;
  outputSchema?: Record<string, unknown>;
}

function setup() {
  const db = openDb(":memory:");
  const now = () => T0;
  const user = ensureUser(db, "owner@example.com", "Owner", T0);
  const { secret } = createApiKey(db, user.id, { name: "Claude", expires: "never" }, T0);
  const hours =
    one<{ id: string }>(db, "SELECT id FROM hours_sets WHERE user_id = ? LIMIT 1", user.id)?.id ??
    "";
  // The app that apply replays staged API calls on: a planner move succeeds.
  const replay = new Hono<AppEnv>();
  replay.post("/api/planner/events/:id/move", (c) => c.json({ ok: true }));
  const preview = createPreview({
    db,
    sync: { runNow: async () => {}, idle: async () => {}, request: () => {} },
    mailer: {},
    live: { notify: () => {} },
    now,
    app: () => replay,
    dry: () => null,
  } as unknown as PreviewDeps);
  const server = mcpRoutes({
    db,
    preview,
    baseUrl: "http://localhost:3000",
    writeEnabled: true,
    now,
  });
  let id = 0;
  const rpc = async (method: string, params?: unknown): Promise<Rpc> => {
    const res = await server.request("/", {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    });
    return (await res.json()) as Rpc;
  };
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await rpc("tools/call", { name, arguments: args })).result as unknown as ToolResult;
  const tool = async <T = Record<string, unknown>>(
    name: string,
    args: Record<string, unknown> = {},
  ) => {
    const r = await call(name, args);
    expect(r.isError, `${name}: ${r.content[0]?.text}`).toBeFalsy();
    return r.structuredContent as T;
  };
  const listTools = async () => (await rpc("tools/list")).result?.tools as ListedTool[];
  return { db, user, hours, preview, rpc, call, tool, listTools };
}

type Setup = ReturnType<typeof setup>;

/** A calendar with an event the user organizes, a past meeting with the same guest and a task event. */
function seedCalendar({ db, user }: Setup) {
  run(
    db,
    "INSERT INTO accounts (id, user_id, provider, external_id, email, credentials, created_at) VALUES ('a1', ?, 'caldav', 'x', ?, '{}', ?)",
    user.id,
    user.email,
    T0,
  );
  run(
    db,
    "INSERT INTO calendars (id, account_id, provider_id, name, writable, is_primary, check_availability) VALUES ('c1', 'a1', 'p1', 'Work', 1, 1, 1)",
  );
  const event = (id: string, title: string, start: number, attendees: string[]) =>
    run(
      db,
      `INSERT INTO events (calendar_id, event_id, summary, location, start_ms, end_ms, attendees, attendee_count, organizer_self)
       VALUES ('c1', ?, ?, 'https://meet.jit.si/plan', ?, ?, ?, ?, 1)`,
      id,
      title,
      start,
      start + HOUR,
      JSON.stringify([user.email, ...attendees]),
      attendees.length + 1,
    );
  event("review", "Roadmap review", T0 + DAY + 2 * HOUR, [GUEST]);
  event("sync", "Roadmap sync", T0 - 7 * DAY, [GUEST]);
  event("solo", "Dentist", T0 + DAY + 6 * HOUR, []);
  for (const [i, id] of ["m1", "m2"].entries())
    run(
      db,
      `INSERT INTO managed_events (id, user_id, calendar_id, key, kind, source_id, start_ms, end_ms, busy, title)
       VALUES (?, ?, 'c1', ?, 'task', 't-roadmap', ?, ?, 1, 'Roadmap draft')`,
      id,
      user.id,
      id,
      T0 + DAY + (4 + i) * HOUR,
      T0 + DAY + (5 + i) * HOUR,
    );
}

function addTask({ db, user, hours }: Setup, id: string, due: number | null, created: number) {
  run(
    db,
    `INSERT INTO tasks (id, user_id, title, level, total_minutes, min_chunk_minutes, max_chunk_minutes,
       start_after, due_at, hours_set_id, created_at, rules_changed_at)
     VALUES (?, ?, ?, 2, 60, 30, 60, ?, ?, ?, ?, ?)`,
    id,
    user.id,
    `Task ${id}`,
    T0,
    due,
    hours,
    created,
    created,
  );
}

function seedAutomations({ db, user, hours }: Setup) {
  for (const [i, level] of [3, 1, 2].entries())
    run(
      db,
      `INSERT INTO habits (id, user_id, title, level, rank, hours_set_id, ideal_minute, min_minutes, max_minutes,
         frequency, defense, when_unplaceable, created_at, rules_changed_at)
       VALUES (?, ?, ?, ?, 0, ?, 540, 30, 60, '{}', 'adaptive', 'remove', ?, ?)`,
      `habit-${i}`,
      user.id,
      `Habit ${i}`,
      level,
      hours,
      T0,
      T0,
    );
  for (const i of [0, 1])
    run(
      db,
      `INSERT INTO focus_goals (id, user_id, title, hours_set_id, weekly_goal_minutes, daily_min_minutes,
         daily_max_minutes, min_block_minutes, max_block_minutes, created_at, rules_changed_at)
       VALUES (?, ?, ?, ?, 600, 60, 240, 60, 120, ?, ?)`,
      `focus-${i}`,
      user.id,
      `Focus ${i}`,
      hours,
      T0,
      T0,
    );
  run(
    db,
    `INSERT INTO buffers (id, user_id, title, level, side, on_conflict, created_at, rules_changed_at)
     VALUES ('buffer-0', ?, 'Buffer', 2, 'after', 'remove', ?, ?)`,
    user.id,
    T0,
    T0,
  );
  run(
    db,
    `INSERT INTO meetings (id, user_id, title, level, frequency, ideal_minute, duration_minutes, shortest_minutes,
       hours_mode, hours_set_id, defense, when_unplaceable, created_at, rules_changed_at)
     VALUES ('meeting-0', ?, '1:1', 2, '{}', 600, 30, 30, 'everyone', ?, 'adaptive', 'remove', ?, ?)`,
    user.id,
    hours,
    T0,
    T0,
  );
  run(
    db,
    `INSERT INTO meeting_overloads (id, user_id, title, hours_set_id, daily_max_minutes, min_block_minutes,
       created_at, rules_changed_at)
     VALUES ('overload-0', ?, 'Meeting limit', ?, 240, 60, ?, ?)`,
    user.id,
    hours,
    T0,
    T0,
  );
}

/** Calls a list tool page by page and returns the ids of every page. */
async function pages(
  s: Setup,
  name: string,
  key: string,
  args: Record<string, unknown>,
  between?: (page: number) => void,
) {
  const out: string[][] = [];
  let cursor: string | undefined;
  do {
    const r = await s.tool<Record<string, unknown> & { next_cursor?: string }>(name, {
      ...args,
      ...(cursor ? { cursor } : {}),
    });
    out.push((r[key] as { id: string }[]).map((x) => x.id));
    cursor = r.next_cursor;
    between?.(out.length);
  } while (cursor && out.length < 50);
  return out;
}

const READ = [
  "list_events",
  "find_free_time",
  "get_week_summary",
  "get_meeting_context",
  "get_stats",
  "list_tasks",
  "list_automations",
  "list_staged_changes",
];
const STAGE = ["propose_create_event", "propose_update_event", "propose_delete_event"];

describe("MCP tool annotations", () => {
  it("marks apply as destructive, the propose tools as non-destructive writes, and the read tools as read-only and idempotent", async () => {
    const tools = await setup().listTools();
    const hints = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
    expect(Object.keys(hints).sort()).toEqual([...READ, ...STAGE, "apply_staged_changes"].sort());
    for (const name of READ)
      expect(hints[name], name).toMatchObject({
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      });
    for (const name of STAGE)
      expect(hints[name], name).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      });
    expect(hints.apply_staged_changes).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
    });
  });
});

describe("MCP output schemas", () => {
  it("declares an object outputSchema for each tool, and the structuredContent of a real call matches it", async () => {
    const s = setup();
    seedCalendar(s);
    seedAutomations(s);
    addTask(s, "t-roadmap", T0 + 3 * DAY, T0);
    addTask(s, "t-open", null, T0);
    const tools = await s.listTools();
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    const validators = new Map(
      tools.map((t) => {
        expect(t.outputSchema, `${t.name} outputSchema`).toMatchObject({ type: "object" });
        return [t.name, ajv.compile(t.outputSchema ?? {})];
      }),
    );
    const checked = new Set<string>();
    const check = async (name: string, args: Record<string, unknown> = {}) => {
      const data = await s.tool(name, args);
      const validate = validators.get(name);
      expect(validate?.(data), `${name}: ${JSON.stringify(validate?.errors)}`).toBe(true);
      checked.add(name);
      return data;
    };
    const day = {
      start: new Date(T0 + DAY).toISOString(),
      end: new Date(T0 + 2 * DAY).toISOString(),
    };

    const { events } = (await check("list_events", day)) as { events: { id: string }[] };
    expect(events.length).toBe(4);
    await check("find_free_time", { duration_minutes: 30, attendees: [GUEST] });
    await check("get_week_summary", { week_start: "2026-10-19" });
    await check("get_meeting_context", { event_id: "ext:c1:review" });
    await check("get_stats", { start_date: "2026-10-12", end_date: "2026-10-25" });
    await check("list_tasks", {});
    await check("list_tasks", { status: "done" });
    await check("list_automations");
    const create = (await check("propose_create_event", {
      title: "Write report",
      ...day,
      attendees: [GUEST],
    })) as { id: string };
    const moveManaged = (await check("propose_update_event", {
      event_id: "m1",
      start: new Date(T0 + DAY + 7 * HOUR).toISOString(),
    })) as { id: string };
    const rename = (await check("propose_update_event", {
      event_id: "ext:c1:solo",
      title: "Dentist (moved)",
    })) as { id: string };
    await check("propose_delete_event", { event_id: "ext:c1:review" });
    await check("list_staged_changes");
    // m1 moves after its move was staged: that change is stale.
    run(s.db, "UPDATE managed_events SET start_ms = start_ms + 900000 WHERE id = 'm1'");
    const moveOther = (await check("propose_update_event", {
      event_id: "m2",
      start: new Date(T0 + DAY + 8 * HOUR).toISOString(),
    })) as { id: string };
    // Applied, stale, failed (no write-through in this harness) and refused, in one call.
    const applied = (await check("apply_staged_changes", {
      ids: [moveOther.id, moveManaged.id, create.id, "not-a-change"],
    })) as { results: { id: string; result: string }[] };
    expect(Object.fromEntries(applied.results.map((r) => [r.id, r.result]))).toEqual({
      [moveOther.id]: "applied",
      [moveManaged.id]: "stale",
      [create.id]: "failed",
      "not-a-change": "refused",
    });
    expect(rename.id).toBeTruthy();
    expect([...checked].sort()).toEqual(tools.map((t) => t.name).sort());
  });

  it("never sends a structuredContent outside the outputSchema: an extra key is dropped, a wrong type is a tool error", async () => {
    const s = setup();
    const tools = await s.listTools();
    const schema = tools.find((t) => t.name === "get_stats")?.outputSchema ?? {};
    expect(schema).toMatchObject({ additionalProperties: false });
    const validate = new Ajv2020({ strict: false }).compile(schema);
    const args = { start_date: "2026-10-12", end_date: "2026-10-18" };
    const real = stats.computeStats(s.db, s.user.id, args.start_date, args.end_date);

    vi.mocked(stats.computeStats).mockReturnValueOnce({
      ...real,
      secret: "not in the schema",
    } as typeof real);
    const extra = await s.call("get_stats", args);
    expect(extra.isError).toBeFalsy();
    expect(extra.structuredContent).not.toHaveProperty("secret");
    expect(validate(extra.structuredContent), JSON.stringify(validate.errors)).toBe(true);
    expect(JSON.parse(extra.content[0]?.text ?? "")).toEqual(extra.structuredContent);

    vi.mocked(stats.computeStats).mockReturnValueOnce({
      ...real,
      from: 20261012,
    } as unknown as typeof real);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const wrong = await s.call("get_stats", args);
    error.mockRestore();
    expect(wrong).toEqual({
      content: [{ type: "text", text: "The tool failed on the server" }],
      isError: true,
    });
    expect(stats.computeStats).toHaveBeenCalledTimes(3);
  });
});

describe("MCP write tools that fail on the server", () => {
  it("say that the change may have been staged or applied, and where to check", async () => {
    const s = setup();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const realStage = s.preview.stage;
    // The change is staged, then the result does not match the outputSchema.
    vi.spyOn(s.preview, "stage").mockImplementationOnce((...args) => ({
      ...realStage(...args),
      id: 42 as unknown as string,
    }));
    const create = await s.call("propose_create_event", {
      title: "Write report",
      start: new Date(T0 + DAY).toISOString(),
      end: new Date(T0 + DAY + HOUR).toISOString(),
    });
    expect(create.isError).toBe(true);
    expect(create.content[0]?.text).toMatch(/may have been staged.*list_staged_changes/);
    const { changes } = await s.tool<{ changes: { id: string }[] }>("list_staged_changes");
    expect(changes).toHaveLength(1);

    // apply_staged_changes fails after it applied the change.
    const realApply = s.preview.apply;
    vi.spyOn(s.preview, "apply").mockImplementationOnce(async (...args) => {
      await realApply(...args);
      throw new Error("lost connection");
    });
    const apply = await s.call("apply_staged_changes", { ids: [changes[0]?.id] });
    expect(apply.isError).toBe(true);
    expect(apply.content[0]?.text).toMatch(/may have been applied.*list_staged_changes/);

    // A read tool that fails changed nothing: the plain message stays.
    vi.mocked(stats.computeStats).mockImplementationOnce(() => {
      throw new Error("boom");
    });
    const read = await s.call("get_stats", { start_date: "2026-10-12", end_date: "2026-10-18" });
    error.mockRestore();
    expect(read).toEqual({
      content: [{ type: "text", text: "The tool failed on the server" }],
      isError: true,
    });
  });
});

describe("MCP list pages", () => {
  it("list_tasks returns every task exactly once over its pages, also when a task is added between pages", async () => {
    const s = setup();
    // Ties on the due date and tasks without one, so the order needs a tie-breaker.
    for (let i = 0; i < 7; i++) addTask(s, `t${i}`, i < 4 ? T0 + DAY : null, T0 + (i % 2));
    const before = await pages(s, "list_tasks", "tasks", { limit: 3 });
    expect(before.map((p) => p.length)).toEqual([3, 3, 1]);
    expect(before.flat().sort()).toEqual(["t0", "t1", "t2", "t3", "t4", "t5", "t6"]);

    // A task due first, added after the first page: an offset would repeat a row.
    const during = await pages(s, "list_tasks", "tasks", { limit: 3 }, (n) => {
      if (n === 1) addTask(s, "t-new", T0, T0 + 5);
    });
    const seen = during.flat();
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.filter((id) => id !== "t-new").sort()).toEqual(before.flat().sort());
  });

  it("list_automations returns every automation exactly once over its pages", async () => {
    const s = setup();
    seedAutomations(s);
    const got = await pages(s, "list_automations", "automations", { limit: 2 });
    expect(got.map((p) => p.length)).toEqual([2, 2, 2, 2, 2, 2, 1]);
    expect(got.flat().sort()).toEqual(
      [
        "buffer-0",
        "focus-0",
        "focus-1",
        "habit-0",
        "habit-1",
        "habit-2",
        "meeting-0",
        "overload-0",
        ...CHECK_IDS,
      ].sort(),
    );
  });

  it("list_automations pages, put together, are the automation list in its order", async () => {
    const s = setup();
    seedAutomations(s);
    // Equal priority, rank and age: the type order and the id decide; ids
    // differ in case, where a locale order and a code point order disagree.
    run(s.db, "UPDATE habits SET level = 2, rank = 0");
    run(s.db, "UPDATE habits SET id = 'Habit-1' WHERE id = 'habit-1'");
    run(s.db, "UPDATE buffers SET rank = 0");
    run(s.db, "UPDATE meetings SET rank = 0");
    const expected = listAutomations(s.db, s.user.id).map((a) => a.id);
    for (const limit of [1, 2, 3, 100])
      expect(
        (await pages(s, "list_automations", "automations", { limit })).flat(),
        `limit ${limit}`,
      ).toEqual(expected);
  });

  it("list_tasks pages more than 100 done tasks in due order, each once", async () => {
    const s = setup();
    for (let i = 0; i < 130; i++)
      addTask(s, `d${String(i).padStart(3, "0")}`, i % 3 ? T0 + (i % 7) * DAY : null, T0 + (i % 5));
    addTask(s, "open-1", T0, T0);
    run(s.db, "UPDATE tasks SET status = 'done' WHERE id LIKE 'd%'");
    const got = await pages(s, "list_tasks", "tasks", { status: "done", limit: 100 });
    expect(got.map((p) => p.length)).toEqual([100, 30]);
    const expected = all<{ id: string }>(
      s.db,
      "SELECT id FROM tasks WHERE status = 'done' ORDER BY due_at IS NULL, due_at, created_at, id",
    ).map((r) => r.id);
    expect(got.flat()).toEqual(expected);
  });

  it("list_automations lists the meeting overload at P4 and the meeting checks last, without priority", async () => {
    const s = setup();
    seedAutomations(s);
    const r = await s.tool<{ automations: { type: string; id: string; level: number | null }[] }>(
      "list_automations",
      { limit: 100 },
    );
    expect(r.automations.find((a) => a.id === "overload-0")).toMatchObject({
      type: "meeting_overload",
      level: 4,
    });
    const checks = r.automations.slice(-CHECK_IDS.length);
    expect(checks.map((a) => a.id)).toEqual([...CHECK_IDS]);
    expect(checks.every((a) => a.type === "meeting_check" && a.level === null)).toBe(true);
  });

  it("list_staged_changes returns every change exactly once over its pages, also when one is staged between pages", async () => {
    const s = setup();
    const stage = (i: number) =>
      s.tool<{ id: string }>("propose_create_event", {
        title: `Event ${i}`,
        start: new Date(T0 + DAY + i * HOUR).toISOString(),
        end: new Date(T0 + DAY + (i + 1) * HOUR).toISOString(),
      });
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await stage(i)).id);
    const got = await pages(s, "list_staged_changes", "changes", { limit: 2 });
    expect(got.map((p) => p.length)).toEqual([2, 2, 1]);
    expect(got.flat().sort()).toEqual([...ids].sort());

    const first = await s.tool<{ changes: { id: string }[]; next_cursor: string }>(
      "list_staged_changes",
      { limit: 2 },
    );
    const added = (await stage(9)).id;
    const rest = await pages(s, "list_staged_changes", "changes", {
      limit: 2,
      cursor: first.next_cursor,
    });
    const seen = [...first.changes.map((c) => c.id), ...rest.flat()];
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.filter((id) => id !== added).sort()).toEqual([...ids].sort());
  });

  it("list_staged_changes pages, put together, are the open changes oldest first, in staging order at one time", async () => {
    const s = setup();
    // The clock stands still: every change has the same created_at, so only
    // the staging order tells them apart (random ids would not).
    const ids: string[] = [];
    for (let i = 0; i < 8; i++)
      ids.push(
        (
          await s.tool<{ id: string }>("propose_create_event", {
            title: `Event ${i}`,
            start: new Date(T0 + DAY + i * HOUR).toISOString(),
            end: new Date(T0 + DAY + (i + 1) * HOUR).toISOString(),
          })
        ).id,
      );
    const listed = async () => {
      const panel = openChanges(s.db, s.user.id, T0).map((c) => c.id);
      for (const limit of [1, 3, 100])
        expect(
          (await pages(s, "list_staged_changes", "changes", { limit })).flat(),
          `limit ${limit}`,
        ).toEqual(panel);
      return panel;
    };
    expect(await listed()).toEqual(ids);

    // Distinct created_at: older first, whatever the staging order.
    const stagedAt = (i: number, t: number) =>
      run(s.db, "UPDATE staged_changes SET created_at = ? WHERE id = ?", t, ids[i] ?? "");
    stagedAt(5, T0 - 2);
    stagedAt(2, T0 - 1);
    stagedAt(7, T0 - 1);
    expect(await listed()).toEqual([5, 2, 7, 0, 1, 3, 4, 6].map((i) => ids[i]));
  });

  it("uses a default limit, refuses a limit above the maximum and refuses a bad cursor", async () => {
    const s = setup();
    for (let i = 0; i < 60; i++) addTask(s, `t${String(i).padStart(2, "0")}`, null, T0 + i);
    const first = await s.tool<{ tasks: unknown[]; next_cursor?: string }>("list_tasks");
    expect(first.tasks).toHaveLength(50);
    expect(first.next_cursor).toEqual(expect.any(String));
    const last = await s.tool<{ tasks: unknown[]; next_cursor?: string }>("list_tasks", {
      cursor: first.next_cursor,
    });
    expect(last.tasks).toHaveLength(10);
    expect(last.next_cursor).toBeUndefined();
    for (const name of ["list_tasks", "list_automations", "list_staged_changes"]) {
      expect((await s.call(name, { limit: 101 })).isError, `${name} limit`).toBe(true);
      expect((await s.call(name, { cursor: "not-a-cursor" })).isError, `${name} cursor`).toBe(true);
    }
    // A cursor belongs to one list and one filter.
    for (const [name, args] of [
      ["list_tasks", { status: "done" }],
      ["list_automations", {}],
      ["list_staged_changes", {}],
    ] as const) {
      const r = await s.call(name, { ...args, cursor: first.next_cursor });
      expect(r.isError, name).toBe(true);
      expect(r.content[0]?.text, name).toMatch(/Invalid cursor/);
    }
  });
});
