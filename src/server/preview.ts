// Preview mode (docs/specs/assistant-preview-mode.md): changes from MCP clients,
// automation edits and planner edits are staged first. Nothing reaches a
// calendar, and nobody is notified, until the user applies them.
import { randomUUID } from "node:crypto";
import type { Hono, MiddlewareHandler } from "hono";
import { plan } from "../scheduler/plan.ts";
import {
  DEFAULT_FORMATS,
  dateText,
  type Formats,
  formatsOf,
  timeText,
  weekdayText,
} from "../shared/formats.ts";
import { utcToLocal } from "../shared/time.ts";
import { createSession, deleteSession } from "./accounts.ts";
import type { AppEnv } from "./app.ts";
import { logChange } from "./change-log.ts";
import { all, type Db, one, run, tx } from "./db.ts";
import { extId } from "./event-ids.ts";
import type { LiveHub } from "./live.ts";
import type { Mailer } from "./mail.ts";
import { stripMarker } from "./planner/markers.ts";
import { planningSnapshot, writeCalendar } from "./planner/replan.ts";
import { getSettings } from "./settings.ts";
import { cacheEvent } from "./sync/pull.ts";
import type { SyncService } from "./sync/service.ts";

const DAY = 86_400_000;
/** Proposed rule 11: pending changes expire after 7 days. */
export const KEEP_DAYS = 7;

export const SOURCES = ["assistant_chat", "mcp_client", "automation_edit", "manual"] as const;
export type Source = (typeof SOURCES)[number];
export type State = "pending" | "accepted" | "discarded" | "applied" | "failed" | "stale";

/** One calendar event a staged change creates, moves or deletes. */
export interface ImpactItem {
  op: "create" | "move" | "delete";
  title: string;
  start: number;
  end: number;
  /** For a move: where the event is now. */
  from?: { start: number; end: number };
  /** The planner id of the live event a move or delete changes. */
  eventId?: string;
}

/** An API call that apply runs again, as the user, with preview mode bypassed. */
export interface ReplayedRequest {
  method: string;
  path: string;
  body: string;
}

export interface EventValues {
  title: string;
  start: number;
  end: number;
  attendees: string[];
  description: string;
  location: string;
}

export type ChangeKind =
  | "request"
  | "event_create"
  | "event_update"
  | "event_delete"
  | "event_rsvp";

export interface StagedChange {
  id: string;
  source: Source;
  client: string;
  kind: ChangeKind;
  target: string | null;
  before: unknown;
  after: unknown;
  impact: ImpactItem[];
  summary: string;
  reason: string;
  state: State;
  result: string;
  createdAt: number;
}

interface Row {
  id: string;
  source: Source;
  client: string;
  kind: ChangeKind;
  target: string | null;
  before: string;
  after: string;
  impact: string;
  summary: string;
  reason: string;
  state: State;
  result: string;
  created_at: number;
}

const fromRow = (r: Row): StagedChange => ({
  id: r.id,
  source: r.source,
  client: r.client,
  kind: r.kind,
  target: r.target,
  before: JSON.parse(r.before),
  after: JSON.parse(r.after),
  impact: JSON.parse(r.impact) as ImpactItem[],
  summary: r.summary,
  reason: r.reason,
  state: r.state,
  result: r.result,
  createdAt: r.created_at,
});

// ---------------------------------------------------------------- mode

export function previewMode(db: Db, userId: string): { on: boolean; byHand: boolean } {
  const r = one<{ enabled: number; by_hand: number }>(
    db,
    "SELECT enabled, by_hand FROM preview_mode WHERE user_id = ?",
    userId,
  );
  return { on: r?.enabled === 1, byHand: r?.by_hand === 1 };
}

export function setPreviewMode(
  db: Db,
  userId: string,
  on: boolean,
  byHand: boolean,
  now: number,
): void {
  run(
    db,
    `INSERT INTO preview_mode (user_id, enabled, by_hand, changed_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET enabled = excluded.enabled, by_hand = excluded.by_hand,
       changed_at = excluded.changed_at`,
    userId,
    on ? 1 : 0,
    on && byHand ? 1 : 0,
    now,
  );
}

// ---------------------------------------------------------------- store

/**
 * The open changes: pending and accepted, not expired. Oldest first; at one
 * created_at, in staging order (rowid). openChanges and openChangesPage share it.
 */
const OPEN = `FROM staged_changes WHERE user_id = ? AND state IN ('pending', 'accepted') AND created_at >= ?`;
const OPEN_ORDER = "ORDER BY created_at, rowid";

/** The open changes, oldest first; expired ones are deleted. */
export function openChanges(db: Db, userId: string, now: number): StagedChange[] {
  const since = now - KEEP_DAYS * DAY;
  run(
    db,
    "DELETE FROM staged_changes WHERE user_id = ? AND state IN ('pending', 'accepted') AND created_at < ?",
    userId,
    since,
  );
  return all<Row>(db, `SELECT * ${OPEN} ${OPEN_ORDER}`, userId, since).map(fromRow);
}

/**
 * One page of the open changes, in openChanges order after the key `after`
 * ([created_at, seq] of the last row). Expired changes are skipped here and
 * deleted by openChanges.
 */
export function openChangesPage(
  db: Db,
  userId: string,
  now: number,
  after: [number, number] | undefined,
  limit: number,
): (StagedChange & { state: "pending" | "accepted"; seq: number })[] {
  return all<Row & { state: "pending" | "accepted"; seq: number }>(
    db,
    `SELECT rowid AS seq, * ${OPEN} AND (created_at, rowid) > (?, ?) ${OPEN_ORDER} LIMIT ?`,
    userId,
    now - KEEP_DAYS * DAY,
    after?.[0] ?? -1,
    after?.[1] ?? -1,
    limit,
  ).map((r) => ({ ...fromRow(r), state: r.state, seq: r.seq }));
}

export interface StageInput {
  source: Source;
  client?: string;
  kind: ChangeKind;
  target?: string | null;
  before?: unknown;
  after: unknown;
  impact: ImpactItem[];
  summary: string;
  reason?: string;
}

/**
 * Stages a change (rule 1) and turns preview mode on (the switch's proposed
 * default). A later change of the same target replaces the earlier one (edge case 1).
 */
export function stage(db: Db, userId: string, input: StageInput, now: number): StagedChange {
  const id = randomUUID();
  tx(db, () => {
    if (input.target) {
      run(
        db,
        `UPDATE staged_changes SET state = 'discarded', result = 'Replaced by a later change', decided_at = ?
         WHERE user_id = ? AND target = ? AND state IN ('pending', 'accepted')`,
        now,
        userId,
        input.target,
      );
    }
    run(
      db,
      `INSERT INTO staged_changes (id, user_id, source, client, kind, target, before, after, impact, summary,
         reason, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      id,
      userId,
      input.source,
      input.client ?? "",
      input.kind,
      input.target ?? null,
      JSON.stringify(input.before ?? null),
      JSON.stringify(input.after),
      JSON.stringify(input.impact),
      input.summary,
      input.reason ?? "",
      now,
    );
    if (!previewMode(db, userId).on) setPreviewMode(db, userId, true, false, now);
  });
  return fromRow(one<Row>(db, "SELECT * FROM staged_changes WHERE id = ?", id) as Row);
}

function setState(db: Db, id: string, state: State, result: string, now: number): void {
  run(
    db,
    "UPDATE staged_changes SET state = ?, result = ?, decided_at = ? WHERE id = ?",
    state,
    result,
    now,
    id,
  );
}

/** Rule 6: accept or discard one pending change; the others stay. */
export function decide(
  db: Db,
  userId: string,
  id: string,
  state: "accepted" | "discarded",
  now: number,
): boolean {
  const { changes } = db
    .prepare(
      `UPDATE staged_changes SET state = ?, decided_at = ? WHERE id = ? AND user_id = ?
       AND state IN ('pending', 'accepted')`,
    )
    .run(state, now, id, userId);
  if (changes) settle(db, userId, now);
  return changes > 0;
}

/** Preview mode that a staged change turned on turns off when nothing is left to review. */
function settle(db: Db, userId: string, now: number): void {
  const mode = previewMode(db, userId);
  if (mode.on && !mode.byHand && openChanges(db, userId, now).length === 0)
    setPreviewMode(db, userId, false, false, now);
}

// ---------------------------------------------------------------- words

/**
 * "Tue 2026-10-27 15:30–16:30" in a zone. Texts the user reads pass the user's
 * formats (settings-profile.md PRF-6); mail to guests keeps the default.
 */
export function when(
  zone: string,
  start: number,
  end?: number,
  f: Formats = DEFAULT_FORMATS,
): string {
  const a = utcToLocal(zone, start);
  const head = `${weekdayText(a.date)} ${dateText(a.date, f)} ${timeText(a.minuteOfDay, f)}`;
  if (end === undefined) return head;
  const b = utcToLocal(zone, end);
  return `${head}–${b.date === a.date ? "" : `${dateText(b.date, f)} `}${timeText(b.minuteOfDay, f)}`;
}

/** One time: "Tue 2026-10-27 15:30", in the formats `f`. */
export const whenAt = (zone: string, t: number, f: Formats) => when(zone, t, undefined, f);

/** The formats of a user's own texts (PRF-6). */
export const userFormatsOf = (db: Db, userId: string) => formatsOf(getSettings(db, userId));

export const zoneOf = (db: Db, userId: string) =>
  one<{ time_zone: string }>(db, "SELECT time_zone FROM users WHERE id = ?", userId)?.time_zone ??
  "UTC";

/** A managed event's title without the state marker that Tempoloom puts in front. */
export function plainTitle(db: Db, userId: string, title: string): string {
  return stripMarker(getSettings(db, userId).markers, title);
}

// ---------------------------------------------------------------- impact

interface Placed {
  key: string;
  title: string;
  start: number;
  end: number;
}

/** What the scheduler would place now, by key. */
export function plannedNow(db: Db, userId: string, now: number): Map<string, Placed> {
  const settings = getSettings(db, userId);
  const last =
    one<{ planned_at: number }>(db, "SELECT planned_at FROM plan_reports WHERE user_id = ?", userId)
      ?.planned_at ?? 0;
  const { snapshot, titles } = planningSnapshot(
    db,
    userId,
    zoneOf(db, userId),
    settings,
    now,
    last,
  );
  const out = new Map<string, Placed>();
  if (settings.paused) return out;
  for (const p of plan(snapshot).placements) {
    if (p.end <= now) continue;
    out.set(p.key, {
      key: p.key,
      title: titles.get(`${p.kind}:${p.itemId}`) ?? p.kind,
      start: p.start,
      end: p.end,
    });
  }
  return out;
}

/** The managed events that differ between two plans: created, moved and deleted. */
export function diffPlans(
  db: Db,
  userId: string,
  before: Map<string, Placed>,
  after: Map<string, Placed>,
): ImpactItem[] {
  const live = new Map(
    all<{ id: string; key: string }>(
      db,
      "SELECT id, key FROM managed_events WHERE user_id = ?",
      userId,
    ).map((r) => [r.key, r.id]),
  );
  const out: ImpactItem[] = [];
  for (const a of after.values()) {
    const b = before.get(a.key);
    if (!b) out.push({ op: "create", title: a.title, start: a.start, end: a.end });
    else if (b.start !== a.start || b.end !== a.end) {
      const eventId = live.get(a.key);
      out.push({
        op: "move",
        title: a.title,
        start: a.start,
        end: a.end,
        from: { start: b.start, end: b.end },
        ...(eventId ? { eventId } : {}),
      });
    }
  }
  for (const b of before.values()) {
    if (after.has(b.key)) continue;
    const eventId = live.get(b.key);
    out.push({
      op: "delete",
      title: b.title,
      start: b.start,
      end: b.end,
      ...(eventId ? { eventId } : {}),
    });
  }
  return out.sort((x, y) => x.start - y.start);
}

export function impactWords(impact: ImpactItem[]): string {
  const n = (op: ImpactItem["op"]) => impact.filter((i) => i.op === op).length;
  const parts = [
    n("create") ? `creates ${n("create")}` : "",
    n("move") ? `moves ${n("move")}` : "",
    n("delete") ? `removes ${n("delete")}` : "",
  ].filter(Boolean);
  if (parts.length === 0) return "No calendar events change";
  return `Calendar: ${parts.join(", ")} event${impact.length === 1 ? "" : "s"}`;
}

// ---------------------------------------------------------------- service

export interface PreviewDeps {
  db: Db;
  sync: SyncService;
  mailer: Mailer;
  live: LiveHub;
  now: () => number;
  /** The app, to run a staged API call again at apply time. */
  app: () => Hono<AppEnv>;
  /** An app on a second database connection, for dry runs inside a rolled-back transaction. */
  dry: () => { app: Hono<AppEnv>; db: Db } | null;
}

export interface ApplyResult {
  applied: { id: string; summary: string }[];
  stale: { id: string; summary: string; reason: string }[];
  failed: { id: string; summary: string; error: string }[];
}

/** Marks a request as a staged change's replay: preview mode does not stage it again. */
const REPLAY = { tlReplay: true };
const isReplay = (env: unknown) => (env as { tlReplay?: boolean } | undefined)?.tlReplay === true;

class Stale extends Error {}

const AUTOMATION = /^\/api\/(habits|focus|buffers)(?:\/([^/]+))?$/;
const MOVE = /^\/api\/planner\/events\/([^/]+)\/move$/;
const TABLES = { habits: "habits", focus: "focus_goals", buffers: "buffers" } as const;
const NOUNS = { habits: "habit", focus: "focus goal", buffers: "buffer" } as const;

export function createPreview(deps: PreviewDeps) {
  const { db, now } = deps;

  /** Runs an API call as the user, on an app, with preview mode bypassed. */
  async function call(
    app: Hono<AppEnv>,
    on: Db,
    userId: string,
    r: ReplayedRequest,
  ): Promise<{ status: number; body: unknown }> {
    const token = createSession(on, userId, now());
    try {
      const res = await app.request(
        r.path,
        {
          method: r.method,
          headers: { cookie: `tl_session=${token}`, "content-type": "application/json" },
          ...(r.body ? { body: r.body } : {}),
        },
        REPLAY,
      );
      const body: unknown = res.status === 204 ? null : await res.json().catch(() => null);
      return { status: res.status, body };
    } finally {
      deleteSession(on, token);
    }
  }

  /**
   * Rule 2: the managed events an automation change would create, move or
   * delete. The call runs on a second connection inside a transaction that is
   * rolled back, so nothing is saved; the plans before and after are compared.
   */
  async function dryRun(
    userId: string,
    r: ReplayedRequest,
  ): Promise<{ status: number; body: unknown; impact: ImpactItem[] }> {
    const dry = deps.dry();
    const t = now();
    const before = plannedNow(db, userId, t);
    if (!dry) return { status: 202, body: null, impact: [] };
    dry.db.exec("BEGIN");
    try {
      const res = await call(dry.app, dry.db, userId, r);
      if (res.status >= 400) return { ...res, impact: [] };
      return { ...res, impact: diffPlans(db, userId, before, plannedNow(dry.db, userId, t)) };
    } finally {
      if (dry.db.isTransaction) dry.db.exec("ROLLBACK");
    }
  }

  /** Stages automation saves and planner drags while preview mode is on (rules 1-3). */
  const guard: MiddlewareHandler<AppEnv> = async (c, next) => {
    if (isReplay(c.env)) return next();
    const { method, path } = c.req;
    const auto = AUTOMATION.exec(path);
    const move = method === "POST" ? MOVE.exec(path) : null;
    const isAutomation =
      auto &&
      ((method === "POST" && !auto[2]) || ((method === "PATCH" || method === "PUT") && auto[2]));
    if (!isAutomation && !move) return next();
    const user = c.get("user");
    if (!previewMode(db, user.id).on) return next();
    const body = await c.req.text();
    const request: ReplayedRequest = { method, path, body };

    if (move) {
      const row = one<{
        id: string;
        kind: string;
        title: string;
        start_ms: number;
        end_ms: number;
      }>(
        db,
        "SELECT id, kind, title, start_ms, end_ms FROM managed_events WHERE id = ? AND user_id = ?",
        move[1] ?? "",
        user.id,
      );
      const start = (JSON.parse(body || "{}") as { start?: unknown }).start;
      if (!row || typeof start !== "number") return next();
      const title = plainTitle(db, user.id, row.title);
      const end = start + (row.end_ms - row.start_ms);
      const staged = stage(
        db,
        user.id,
        {
          source: "manual",
          kind: "request",
          target: `managed:${row.id}`,
          before: { start: row.start_ms, end: row.end_ms },
          after: request,
          impact: [
            {
              op: "move",
              title,
              start,
              end,
              from: { start: row.start_ms, end: row.end_ms },
              eventId: row.id,
            },
          ],
          summary: `Move “${title}” to ${when(zoneOf(db, user.id), start, end, userFormatsOf(db, user.id))}`,
        },
        now(),
      );
      return c.json({ staged }, 202);
    }

    const [, plural, id] = auto as RegExpExecArray;
    const table = TABLES[plural as keyof typeof TABLES];
    const noun = NOUNS[plural as keyof typeof NOUNS];
    const current = id
      ? one<Record<string, unknown>>(
          db,
          `SELECT * FROM ${table} WHERE id = ? AND user_id = ?`,
          id,
          user.id,
        )
      : undefined;
    if (id && !current) return next();
    const dry = await dryRun(user.id, request);
    if (dry.status >= 400) return c.json(dry.body as object, dry.status as 400);
    const fields = (JSON.parse(body || "{}") ?? {}) as { title?: string; enabled?: boolean };
    const title = String(
      current?.title ?? fields.title ?? (plural === "focus" ? "Focus time" : noun),
    );
    const switched =
      current && fields.enabled !== undefined && Boolean(current.enabled) !== fields.enabled
        ? fields.enabled
          ? " (turn on)"
          : " (turn off)"
        : "";
    const staged = stage(
      db,
      user.id,
      {
        source: "automation_edit",
        kind: "request",
        target: id ? `${plural}:${id}` : null,
        before: current ? { table, id, rulesChangedAt: current.rules_changed_at } : null,
        after: request,
        impact: dry.impact,
        summary: `${id ? "Edit" : "New"} ${noun} “${title}”${switched}`,
      },
      now(),
    );
    return c.json({ staged }, 202);
  };

  // ---------------------------------------------------------------- apply

  async function notifyAttendees(
    userId: string,
    attendees: string[],
    subject: string,
    lines: string[],
  ): Promise<void> {
    if (!deps.mailer.configured) return;
    const user = one<{ email: string; name: string }>(
      db,
      "SELECT email, name FROM users WHERE id = ?",
      userId,
    );
    for (const to of attendees) {
      if (to === user?.email) continue;
      await deps.mailer.send({
        to,
        subject,
        text: [
          ...lines,
          `Organizer: ${user?.name ?? ""} <${user?.email ?? ""}>`,
          "",
          "Sent by Tempoloom.",
        ].join("\n"),
      });
    }
  }

  interface Cached {
    calendar_id: string;
    event_id: string;
    summary: string;
    start_ms: number;
    end_ms: number;
    etag: string | null;
    attendees: string;
    account_id: string;
    provider_id: string;
  }

  /** The cached event behind an "ext:<calendar>:<event>" id, on a calendar of the user. */
  function cachedEvent(userId: string, target: string): Cached | undefined {
    const ref = extId(target);
    if (!ref) return undefined;
    return one<Cached>(
      db,
      `SELECT e.calendar_id, e.event_id, e.summary, e.start_ms, e.end_ms, e.etag, e.attendees,
         c.account_id, c.provider_id
       FROM events e JOIN calendars c ON c.id = e.calendar_id JOIN accounts a ON a.id = c.account_id
       WHERE a.user_id = ? AND e.calendar_id = ? AND e.event_id = ?`,
      userId,
      ref.calendarId,
      ref.eventId,
    );
  }

  async function applyOne(userId: string, ch: StagedChange): Promise<void> {
    const zone = zoneOf(db, userId);
    if (ch.kind === "request") {
      const before = ch.before as
        | { table: string; id: string; rulesChangedAt: number }
        | { start: number; end: number }
        | null;
      if (before && "table" in before) {
        const cur = one<{ rules_changed_at: number }>(
          db,
          `SELECT rules_changed_at FROM ${before.table} WHERE id = ? AND user_id = ?`,
          before.id,
          userId,
        );
        if (!cur) throw new Stale("The automation was deleted after this change was staged");
        if (cur.rules_changed_at !== before.rulesChangedAt)
          throw new Stale("The automation changed after this change was staged");
      } else if (before && ch.target?.startsWith("managed:")) {
        const cur = one<{ start_ms: number; end_ms: number }>(
          db,
          "SELECT start_ms, end_ms FROM managed_events WHERE id = ? AND user_id = ?",
          ch.target.slice(8),
          userId,
        );
        if (!cur) throw new Stale("The event was removed after this change was staged");
        if (cur.start_ms !== before.start || cur.end_ms !== before.end)
          throw new Stale("The event changed after it was staged");
      }
      const res = await call(deps.app(), db, userId, ch.after as ReplayedRequest);
      if (res.status >= 400) {
        const b = res.body as { message?: string; error?: string; issues?: { message: string }[] };
        throw new Error(b?.issues?.[0]?.message ?? b?.message ?? b?.error ?? `HTTP ${res.status}`);
      }
      return;
    }

    if (ch.kind === "event_create") {
      const v = ch.after as EventValues;
      const target = writeCalendar(db, userId);
      if (!target) throw new Error("No calendar to write to");
      const email = one<{ email: string }>(
        db,
        "SELECT email FROM users WHERE id = ?",
        userId,
      )?.email;
      const ev = await deps.sync.exclusive(userId, (pool) =>
        pool.get(target.account_id).insertEvent(target.provider_id, {
          summary: v.title,
          description: v.description,
          start: v.start,
          end: v.end,
          busy: true,
          colorId: null,
          privateProps: {},
          ...(v.location ? { location: v.location } : {}),
          ...(v.attendees.length && email ? { attendees: v.attendees, organizer: email } : {}),
        }),
      );
      cacheEvent(db, target.id, ev);
      logChange(
        db,
        userId,
        {
          calendarId: target.id,
          eventId: ev.id,
          action: "create",
          item: `preview:${ch.id}`,
          reason: "applied from preview mode",
          title: v.title,
          start: v.start,
          end: v.end,
        },
        now(),
      );
      await notifyAttendees(userId, v.attendees, `Invitation: ${v.title}`, [
        v.title,
        `When: ${when(zone, v.start, v.end)} (${zone})`,
        ...(v.location ? [`Where: ${v.location}`] : []),
      ]);
      return;
    }

    // An external event: it must still be as it was at staging time (rule 12).
    const before = ch.before as { title: string; start: number; end: number };
    const cur = cachedEvent(userId, ch.target ?? "");
    if (!cur) throw new Stale("The event was deleted after this change was staged");
    if (cur.start_ms !== before.start || cur.end_ms !== before.end || cur.summary !== before.title)
      throw new Stale("The event changed after it was staged");
    const attendees = JSON.parse(cur.attendees) as string[];
    if (ch.kind === "event_rsvp") {
      const { response } = ch.after as { response: "accepted" | "declined" | "tentative" };
      const ev = await deps.sync.exclusive(userId, (pool) =>
        pool
          .get(cur.account_id)
          .editExternal(cur.provider_id, cur.event_id, { selfResponse: response }, cur.etag),
      );
      cacheEvent(db, cur.calendar_id, ev);
      logChange(
        db,
        userId,
        {
          calendarId: cur.calendar_id,
          eventId: cur.event_id,
          action: "update",
          item: `preview:${ch.id}`,
          reason: `answered ${response} from preview mode`,
          title: cur.summary,
          start: cur.start_ms,
          end: cur.end_ms,
        },
        now(),
      );
      return;
    }
    if (ch.kind === "event_delete") {
      await deps.sync.exclusive(userId, (pool) =>
        pool.get(cur.account_id).deleteEvent(cur.provider_id, cur.event_id),
      );
      run(
        db,
        "DELETE FROM events WHERE calendar_id = ? AND event_id = ?",
        cur.calendar_id,
        cur.event_id,
      );
      logChange(
        db,
        userId,
        {
          calendarId: cur.calendar_id,
          eventId: cur.event_id,
          action: "delete",
          item: `preview:${ch.id}`,
          reason: "applied from preview mode",
          title: cur.summary,
          start: cur.start_ms,
          end: cur.end_ms,
        },
        now(),
      );
      await notifyAttendees(userId, attendees, `Cancelled: ${cur.summary}`, [
        `${cur.summary} on ${when(zone, cur.start_ms, cur.end_ms)} (${zone}) is cancelled.`,
      ]);
      return;
    }
    // A description comes from the chat's video link fix (assistant-chat.md rule 16).
    const v = ch.after as { title?: string; start: number; end: number; description?: string };
    const title = v.title ?? cur.summary;
    const ev = await deps.sync.exclusive(userId, (pool) =>
      pool.get(cur.account_id).editExternal(
        cur.provider_id,
        cur.event_id,
        {
          start: v.start,
          end: v.end,
          ...(v.title ? { summary: v.title } : {}),
          ...(v.description !== undefined ? { description: v.description } : {}),
        },
        cur.etag,
      ),
    );
    cacheEvent(db, cur.calendar_id, ev);
    logChange(
      db,
      userId,
      {
        calendarId: cur.calendar_id,
        eventId: cur.event_id,
        action: "update",
        item: `preview:${ch.id}`,
        reason: "applied from preview mode",
        title,
        start: v.start,
        end: v.end,
      },
      now(),
    );
    const moved = v.start !== cur.start_ms || v.end !== cur.end_ms;
    await notifyAttendees(
      userId,
      attendees,
      `Updated: ${title}`,
      moved
        ? [
            `${title} moved to ${when(zone, v.start, v.end)} (${zone}).`,
            `It was ${when(zone, cur.start_ms, cur.end_ms)}.`,
          ]
        : [
            `${title} on ${when(zone, v.start, v.end)} (${zone}) changed.`,
            ...(v.description !== undefined ? ["", v.description] : []),
          ],
    );
  }

  /**
   * Rules 8, 12, 13: writes the chosen changes in the order they were staged.
   * A change whose target changed since staging is skipped as stale; a write
   * error marks only that change failed.
   */
  async function apply(userId: string, ids: string[]): Promise<ApplyResult> {
    const wanted = new Set(ids);
    const changes = openChanges(db, userId, now()).filter((c) => wanted.has(c.id));
    const out: ApplyResult = { applied: [], stale: [], failed: [] };
    if (changes.length === 0) return out;
    // Read the calendars first, so the stale check sees edits made elsewhere.
    await deps.sync.runNow(userId);
    await deps.sync.idle(userId);
    for (const ch of changes) {
      try {
        await applyOne(userId, ch);
        setState(db, ch.id, "applied", "", now());
        out.applied.push({ id: ch.id, summary: ch.summary });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (err instanceof Stale) {
          setState(db, ch.id, "stale", message, now());
          out.stale.push({ id: ch.id, summary: ch.summary, reason: message });
        } else {
          setState(db, ch.id, "failed", message, now());
          out.failed.push({ id: ch.id, summary: ch.summary, error: message });
        }
      }
    }
    settle(db, userId, now());
    deps.sync.request(userId, 0);
    deps.live.notify(userId);
    return out;
  }

  return {
    guard,
    apply,
    cachedEvent,
    stage: (userId: string, input: StageInput) => {
      const s = stage(db, userId, input, now());
      deps.live.notify(userId);
      return s;
    },
    dryRun,
  };
}

export type Preview = ReturnType<typeof createPreview>;
