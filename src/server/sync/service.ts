// Runs calendar sync and planning for each user, one run at a time per user.
import { all, one, run } from "../db.ts";
import { enforceCalendarLimit } from "../limits.ts";
import { oooOwnersOf, syncOutOfOffice } from "../ooo.ts";
import { autoLock } from "../planner/auto-lock.ts";
import { observeMeetings } from "../planner/meeting-log.ts";
import { meetingPeers } from "../planner/meetings.ts";
import { finishPaint, type PaintJob, writePaint } from "../planner/repaint.ts";
import { replanUser } from "../planner/replan.ts";
import { enforceAgendas } from "../policies/agendas.ts";
import { applyPolicies } from "../policies/apply.ts";
import { type ProviderDeps, ProviderPool } from "../providers/index.ts";
import { ProviderError } from "../providers/types.ts";
import { getSettings } from "../settings.ts";
import { applyCalendarEdits } from "./edits.ts";
import { MIRROR_READ_AHEAD, pullEvents, syncCalendarList } from "./pull.ts";

export interface SyncServiceDeps extends ProviderDeps {
  intervalMs: number;
  baseUrl: string;
  /** How often people who never signed in are read (default 24 hours). */
  refreshMs?: number;
  /** How often all mirroring policies get a full reconcile (default 12 hours; mirroring rule 39). */
  mirrorReconcileMs?: number;
  log?: (msg: string, err?: unknown) => void;
}

const DEBOUNCE_MS = 300;
/** Color writes per step of a repaint job; runs asked for meanwhile go between steps. */
const PAINT_STEP = 20;
const CALENDAR_LIST_EVERY_MS = 10 * 60_000;
const REFRESH_MS = 86_400_000;
const MIRROR_RECONCILE_MS = 12 * 3_600_000;

export class SyncService {
  readonly #deps: SyncServiceDeps;
  readonly #tail = new Map<string, Promise<void>>();
  readonly #queued = new Map<string, Promise<void>>();
  readonly #timers = new Map<string, NodeJS.Timeout>();
  /** The newest repaint job per user; an older job stops when a newer one starts. */
  readonly #paintJobs = new Map<string, PaintJob>();
  /**
   * Managed keys to repair on the user's next run (support-troubleshooting.md
   * rule 10), and the keys that run checked in full or wrote.
   */
  readonly #repairs = new Map<string, { keys: Set<string>; done: Set<string> }>();
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

  /**
   * Marks an account disconnected when its server rejects the stored login
   * (accounts-login-emails-permissions.md rules 14, 16): Tempoloom then stops
   * reading and writing its calendars until the user reconnects it. Returns
   * true for a rejected login; other errors are the caller's. Only the login
   * that the provider used is marked: a reconnect saved while the request was
   * open stays connected.
   */
  #disconnected(pool: ProviderPool, accountId: string, err: unknown): boolean {
    if (!(err instanceof ProviderError && err.kind === "auth")) return false;
    const { changes } = this.#deps.db
      .prepare("UPDATE accounts SET status = 'reauth_required' WHERE id = ? AND credentials IS ?")
      .run(accountId, pool.credentialsOf(accountId) ?? null);
    this.#log(
      changes > 0
        ? `account ${accountId} is disconnected: the server rejected its login`
        : `account ${accountId}: an old login was rejected; the new login is kept`,
    );
    return true;
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

  /** Accounts read before this time are due, for people who never signed in. */
  #refreshDue(): number {
    return this.#deps.now() - (this.#deps.refreshMs ?? REFRESH_MS);
  }

  start(): void {
    this.#interval = setInterval(() => {
      for (const { user_id } of all<{ user_id: string }>(
        this.#deps.db,
        `SELECT DISTINCT a.user_id FROM accounts a JOIN users u ON u.id = a.user_id
         WHERE a.status = 'ok' AND u.deactivated_at IS NULL
           AND (u.first_sign_in_at IS NOT NULL OR a.refreshed_at IS NULL OR a.refreshed_at <= ?)`,
        this.#refreshDue(),
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

  /**
   * Runs one sync and replan that writes the given managed events again,
   * compared in full. True when that run checked or wrote every key; false
   * when the run failed or left a key as it is.
   */
  async repair(userId: string, keys: string[]): Promise<boolean> {
    const job = this.#repairs.get(userId) ?? { keys: new Set<string>(), done: new Set<string>() };
    for (const k of keys) job.keys.add(k);
    this.#repairs.set(userId, job);
    await this.runNow(userId);
    return keys.every((k) => job.done.has(k));
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

  /**
   * Writes the colors a run listed (events-categories-and-colors.md rule 16):
   * a background job, queued after the run in steps, so a run asked for while
   * it paints goes before the next step and is never delayed by a whole repaint.
   */
  #paint(userId: string, job: PaintJob): void {
    // A newer run always ends an older job, also when it has nothing to paint.
    if (job.paints.length === 0 && job.requestedAt === null) {
      this.#paintJobs.delete(userId);
      return;
    }
    this.#paintJobs.set(userId, job);
    const pool = this.#pool(userId);
    const ctx = { db: this.#deps.db, provider: (id: string) => pool.get(id) };
    let done = true;
    const step = (from: number) =>
      void this.#enqueue(userId, async () => {
        if (this.#stopped || this.#paintJobs.get(userId) !== job) return;
        try {
          for (const p of job.paints.slice(from, from + PAINT_STEP))
            if (!(await writePaint(ctx, p))) done = false;
        } catch (err) {
          done = false;
          this.#log(`repaint failed for user ${userId}`, err);
        }
        if (from + PAINT_STEP < job.paints.length) return step(from + PAINT_STEP);
        this.#paintJobs.delete(userId);
        finishPaint(this.#deps.db, userId, job, done);
      });
    step(0);
  }

  async #run(userId: string): Promise<void> {
    const { db } = this.#deps;
    try {
      const user = one<{ time_zone: string; first_sign_in_at: number | null }>(
        db,
        "SELECT time_zone, first_sign_in_at FROM users WHERE id = ? AND deactivated_at IS NULL",
        userId,
      );
      if (!user) return;
      // A provisioned person who never signed in is read once per refresh period
      // (admin-sso-provisioning.md rule 17), and never planned (outputs, open question 3).
      const signedIn = user.first_sign_in_at !== null;
      if (
        !signedIn &&
        !one(
          db,
          `SELECT 1 FROM accounts WHERE user_id = ? AND status = 'ok'
             AND (refreshed_at IS NULL OR refreshed_at <= ?)`,
          userId,
          this.#refreshDue(),
        )
      ) {
        return;
      }
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
        try {
          await syncCalendarList(db, pool.get(a.id), a.id, userId);
        } catch (err) {
          if (this.#disconnected(pool, a.id, err)) continue;
          throw err;
        }
        run(db, "UPDATE accounts SET calendars_synced_at = ? WHERE id = ?", now0, a.id);
      }
      // A lower instance limit turns extra connected calendars off (plans edge case 1).
      enforceCalendarLimit(db, userId);
      // Mirroring calendars are read 12 months ahead. Twice a day (by default) they
      // are read in full and every copy is checked field by field (mirroring rule 39).
      const mirrored = new Set(
        all<{ s: string; d: string }>(
          db,
          "SELECT source_calendar_id AS s, dest_calendar_id AS d FROM mirror_policies WHERE user_id = ? AND enabled = 1",
          userId,
        ).flatMap((p) => [p.s, p.d]),
      );
      const reconciled =
        one<{ at: number | null }>(
          db,
          "SELECT mirror_reconciled_at AS at FROM users WHERE id = ?",
          userId,
        )?.at ?? null;
      const fullMirror =
        mirrored.size > 0 &&
        (reconciled === null ||
          now0 - reconciled >= (this.#deps.mirrorReconcileMs ?? MIRROR_RECONCILE_MS));
      if (fullMirror)
        for (const id of mirrored)
          run(db, "UPDATE calendars SET sync_token = NULL WHERE id = ?", id);
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
      const lost = new Set<string>();
      for (const cal of calendars) {
        if (lost.has(cal.account_id)) continue;
        try {
          pulled += await pullEvents(
            db,
            pool.get(cal.account_id),
            cal.id,
            now,
            mirrored.has(cal.id) ? MIRROR_READ_AHEAD : undefined,
          );
        } catch (err) {
          if (!this.#disconnected(pool, cal.account_id, err)) throw err;
          lost.add(cal.account_id);
        }
      }
      if (!signedIn) {
        run(
          db,
          "UPDATE accounts SET refreshed_at = ? WHERE user_id = ? AND status = 'ok'",
          now,
          userId,
        );
        return;
      }
      // Flexible meetings: the organizer's edits and guests' declines (MEET-02 rules 2, 31).
      observeMeetings(
        db,
        userId,
        calendars.map((c) => c.id),
        now,
      );
      applyCalendarEdits(
        db,
        userId,
        calendars.map((c) => c.id),
        user.time_zone,
        now,
      );
      // The daily or weekly auto-lock run (planning-locks.md LCK-30, LCK-31).
      autoLock(db, userId, getSettings(db, userId), now);
      // Team policies (teams-policies.md rules 3, 14-17): automations, then agendas.
      // A policy failure never stops the member's own planning.
      try {
        applyPolicies(db, userId, now);
        await enforceAgendas(
          db,
          userId,
          (id) => pool.get(id),
          now,
          (m, e) => this.#log(m, e),
        );
      } catch (err) {
        this.#log(`team policies failed for user ${userId}`, err);
      }
      const repair = this.#repairs.get(userId);
      this.#repairs.delete(userId);
      // A repair counts only when the whole run succeeds.
      const done = new Set<string>();
      const result = await replanUser(
        {
          db,
          provider: (accountId) => pool.get(accountId),
          now: this.#deps.now(),
          baseUrl: this.#deps.baseUrl,
          fullMirror,
          ...(repair ? { repair: repair.keys, repaired: done } : {}),
        },
        userId,
      );
      if (fullMirror)
        run(db, "UPDATE users SET mirror_reconciled_at = ? WHERE id = ?", now, userId);
      if (result) this.#paint(userId, result.paint);
      for (const k of done) repair?.done.add(k);
      // Team out-of-office calendars this user owns (teams-ooo-calendar.md).
      await syncOutOfOffice(db, userId, pool, this.#deps.now());
      // Flexible meetings join calendars of several users (meetings-flexible.md
      // rules 13, 27): a change on one side plans the other side again. The
      // owners of shared out-of-office calendars copy this user's time away.
      const peers = meetingPeers(db, userId);
      if (pulled > 0)
        for (const id of [...peers.organizers, ...oooOwnersOf(db, userId)]) this.request(id);
      const p = result?.push;
      if (p && p.created + p.updated + p.deleted > 0) {
        for (const id of peers.attendees) this.request(id);
        // A CalDAV tag hashes the calendar's content, and the stored tag predates
        // these writes: an edit that restores that content (say, deleting a chunk
        // just written) would match it and go unseen. Read those calendars in full.
        run(
          db,
          `UPDATE calendars SET sync_token = NULL
           WHERE id IN (SELECT calendar_id FROM managed_events WHERE user_id = ?)
             AND account_id IN (SELECT id FROM accounts WHERE provider = 'caldav')`,
          userId,
        );
      }
      if (pulled > 0 || (p && p.created + p.updated + p.deleted > 0))
        for (const fn of this.#listeners) fn(userId);
    } catch (err) {
      this.#log(`sync failed for user ${userId}`, err);
    }
  }
}
