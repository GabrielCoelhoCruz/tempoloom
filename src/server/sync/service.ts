// Runs calendar sync and planning for each user, one run at a time per user.
import { all, one, run } from "../db.ts";
import { meetingPeers } from "../planner/meetings.ts";
import { replanUser } from "../planner/replan.ts";
import { type ProviderDeps, ProviderPool } from "../providers/index.ts";
import { applyCalendarEdits } from "./edits.ts";
import { pullEvents, syncCalendarList } from "./pull.ts";

export interface SyncServiceDeps extends ProviderDeps {
  intervalMs: number;
  baseUrl: string;
  log?: (msg: string, err?: unknown) => void;
}

const DEBOUNCE_MS = 300;
const CALENDAR_LIST_EVERY_MS = 10 * 60_000;

export class SyncService {
  readonly #deps: SyncServiceDeps;
  readonly #tail = new Map<string, Promise<void>>();
  readonly #queued = new Map<string, Promise<void>>();
  readonly #timers = new Map<string, NodeJS.Timeout>();
  #interval: NodeJS.Timeout | undefined;
  #stopped = false;
  readonly #listeners = new Set<(userId: string) => void>();

  constructor(deps: SyncServiceDeps) {
    this.#deps = deps;
  }

  #log(msg: string, err?: unknown): void {
    (this.#deps.log ?? ((m, e) => console.error(m, e ?? "")))(msg, err);
  }

  /** Calls fn after each run that read or wrote changes of the user's calendars. */
  onChange(fn: (userId: string) => void): void {
    this.#listeners.add(fn);
  }

  pool(userId: string): ProviderPool {
    return this.#pool(userId);
  }

  #pool(userId: string): ProviderPool {
    const zone =
      one<{ time_zone: string }>(this.#deps.db, "SELECT time_zone FROM users WHERE id = ?", userId)
        ?.time_zone ?? "UTC";
    return new ProviderPool(this.#deps, zone);
  }

  start(): void {
    this.#interval = setInterval(() => {
      for (const { user_id } of all<{ user_id: string }>(
        this.#deps.db,
        `SELECT DISTINCT a.user_id FROM accounts a JOIN users u ON u.id = a.user_id
         WHERE a.status = 'ok' AND u.deactivated_at IS NULL`,
      )) {
        this.request(user_id, 0);
      }
    }, this.#deps.intervalMs);
  }

  /** Stops new work and resolves when the work already queued has finished. */
  async stop(): Promise<void> {
    this.#stopped = true;
    clearInterval(this.#interval);
    for (const t of this.#timers.values()) clearTimeout(t);
    this.#timers.clear();
    await Promise.all([...this.#tail.values()]);
  }

  /** Reads the account's calendar list, then plans. */
  async onConnect(userId: string, accountId: string): Promise<void> {
    try {
      await syncCalendarList(this.#deps.db, this.#pool(userId).get(accountId), accountId, userId);
      run(
        this.#deps.db,
        "UPDATE accounts SET calendars_synced_at = ? WHERE id = ?",
        this.#deps.now(),
        accountId,
      );
    } catch (err) {
      this.#log(`calendar list sync failed for account ${accountId}`, err);
    }
    this.request(userId, 0);
  }

  /** Reads every calendar list of the user now, inside the user's queue. */
  async refreshCalendars(userId: string): Promise<void> {
    await this.exclusive(userId, async (pool) => {
      for (const a of all<{ id: string }>(
        this.#deps.db,
        "SELECT id FROM accounts WHERE user_id = ? AND status = 'ok'",
        userId,
      )) {
        await syncCalendarList(this.#deps.db, pool.get(a.id), a.id, userId);
        run(
          this.#deps.db,
          "UPDATE accounts SET calendars_synced_at = ? WHERE id = ?",
          this.#deps.now(),
          a.id,
        );
      }
    });
  }

  /** Asks for a sync and replan of a user. Calls within the debounce window merge. */
  request(userId: string, delayMs = DEBOUNCE_MS): void {
    if (this.#stopped) return;
    clearTimeout(this.#timers.get(userId));
    this.#timers.set(
      userId,
      setTimeout(() => {
        this.#timers.delete(userId);
        void this.runNow(userId);
      }, delayMs),
    );
  }

  /** Runs fn after the user's queued work. Work for one user never overlaps. */
  #enqueue<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.#tail.get(userId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.#tail.set(
      userId,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  /** Queues one sync and replan. A run that is queued but not started absorbs later calls. */
  runNow(userId: string): Promise<void> {
    const queued = this.#queued.get(userId);
    if (queued) return queued;
    const job = this.#enqueue(userId, async () => {
      this.#queued.delete(userId);
      await this.#run(userId);
    });
    this.#queued.set(userId, job);
    return job;
  }

  /** Runs a calendar write for the user inside the user's queue, then plans again. */
  async exclusive<T>(userId: string, fn: (pool: ProviderPool) => Promise<T>): Promise<T> {
    const result = await this.#enqueue(userId, () => fn(this.#pool(userId)));
    this.request(userId, 0);
    return result;
  }

  /** Resolves when no work is active or queued for the user. */
  async idle(userId: string): Promise<void> {
    for (;;) {
      const tail = this.#tail.get(userId);
      if (tail) await tail;
      if (this.#timers.has(userId)) {
        await new Promise((res) => setTimeout(res, DEBOUNCE_MS + 10));
        continue;
      }
      if (this.#tail.get(userId) === tail) return;
    }
  }

  async #run(userId: string): Promise<void> {
    const { db } = this.#deps;
    try {
      const user = one<{ time_zone: string }>(
        db,
        "SELECT time_zone FROM users WHERE id = ? AND deactivated_at IS NULL",
        userId,
      );
      if (!user) return;
      const pool = this.#pool(userId);
      // Read each account's calendar list on first sight and every 10 minutes.
      const now0 = this.#deps.now();
      for (const a of all<{ id: string }>(
        db,
        `SELECT id FROM accounts WHERE user_id = ? AND status = 'ok'
           AND (calendars_synced_at IS NULL OR calendars_synced_at < ?)`,
        userId,
        now0 - CALENDAR_LIST_EVERY_MS,
      )) {
        await syncCalendarList(db, pool.get(a.id), a.id, userId);
        run(db, "UPDATE accounts SET calendars_synced_at = ? WHERE id = ?", now0, a.id);
      }
      const calendars = all<{ id: string; account_id: string }>(
        db,
        `SELECT c.id, c.account_id FROM calendars c JOIN accounts a ON a.id = c.account_id
         WHERE a.user_id = ? AND a.status = 'ok' AND (c.check_availability = 1 OR c.is_primary = 1
           OR EXISTS (SELECT 1 FROM managed_events m WHERE m.calendar_id = c.id)
           OR EXISTS (SELECT 1 FROM mirror_policies p WHERE p.enabled = 1
                      AND (p.source_calendar_id = c.id OR p.dest_calendar_id = c.id)))`,
        userId,
      );
      const now = this.#deps.now();
      let pulled = 0;
      for (const cal of calendars) {
        pulled += await pullEvents(db, pool.get(cal.account_id), cal.id, now);
      }
      applyCalendarEdits(
        db,
        userId,
        calendars.map((c) => c.id),
        user.time_zone,
        now,
      );
      const result = await replanUser(
        {
          db,
          provider: (accountId) => pool.get(accountId),
          now: this.#deps.now(),
          baseUrl: this.#deps.baseUrl,
        },
        userId,
      );
      // Flexible meetings join calendars of several users (meetings-flexible.md
      // rules 13, 27): a change on one side plans the other side again.
      const peers = meetingPeers(db, userId);
      if (pulled > 0) for (const id of peers.organizers) this.request(id);
      const p = result?.push;
      if (p && p.created + p.updated + p.deleted > 0) {
        for (const id of peers.attendees) this.request(id);
      }
      if (pulled > 0 || (p && p.created + p.updated + p.deleted > 0))
        for (const fn of this.#listeners) fn(userId);
    } catch (err) {
      this.#log(`sync failed for user ${userId}`, err);
    }
  }
}
