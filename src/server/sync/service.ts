// Runs calendar sync and planning for each user, one run at a time per user.
import { accessTokenFor } from "../accounts.ts";
import type { SecretBox } from "../crypto.ts";
import { all, type Db } from "../db.ts";
import { GoogleCalendarApi } from "../google/calendar.ts";
import type { OAuthClient } from "../google/oauth.ts";
import { replanUser } from "../planner/replan.ts";
import { pullEvents, syncCalendarList } from "./pull.ts";

export interface SyncServiceDeps {
  db: Db;
  box: SecretBox;
  oauth: OAuthClient | undefined;
  intervalMs: number;
  now?: () => number;
  log?: (msg: string, err?: unknown) => void;
}

const DEBOUNCE_MS = 300;

export class SyncService {
  readonly #deps: SyncServiceDeps;
  readonly #running = new Map<string, Promise<void>>();
  readonly #pending = new Set<string>();
  readonly #timers = new Map<string, NodeJS.Timeout>();
  #interval: NodeJS.Timeout | undefined;

  constructor(deps: SyncServiceDeps) {
    this.#deps = deps;
  }

  apiFor(accountId: string): GoogleCalendarApi {
    const { db, box, oauth } = this.#deps;
    if (!oauth) throw new Error("Google OAuth is not configured");
    return new GoogleCalendarApi({
      getAccessToken: () => accessTokenFor(db, box, oauth, accountId, this.#now()),
    });
  }

  #now(): number {
    return this.#deps.now?.() ?? Date.now();
  }

  #log(msg: string, err?: unknown): void {
    (this.#deps.log ?? ((m, e) => console.error(m, e ?? "")))(msg, err);
  }

  start(): void {
    this.#interval = setInterval(() => {
      for (const { user_id } of all<{ user_id: string }>(
        this.#deps.db,
        "SELECT DISTINCT user_id FROM google_accounts WHERE status = 'ok'",
      )) {
        this.request(user_id, 0);
      }
    }, this.#deps.intervalMs);
  }

  stop(): void {
    clearInterval(this.#interval);
    for (const t of this.#timers.values()) clearTimeout(t);
  }

  async onLogin(userId: string, accountId: string): Promise<void> {
    try {
      await syncCalendarList(this.#deps.db, this.apiFor(accountId), accountId, userId);
    } catch (err) {
      this.#log(`calendar list sync failed for account ${accountId}`, err);
    }
    this.request(userId, 0);
  }

  /** Asks for a sync and replan of a user. Calls within the debounce window merge. */
  request(userId: string, delayMs = DEBOUNCE_MS): void {
    clearTimeout(this.#timers.get(userId));
    this.#timers.set(
      userId,
      setTimeout(() => {
        this.#timers.delete(userId);
        void this.runNow(userId);
      }, delayMs),
    );
  }

  /** Runs a sync and replan now. A run already in progress is followed by exactly one more. */
  runNow(userId: string): Promise<void> {
    const current = this.#running.get(userId);
    if (current) {
      this.#pending.add(userId);
      return current;
    }
    const run = this.#run(userId).finally(() => {
      this.#running.delete(userId);
      if (this.#pending.delete(userId)) void this.runNow(userId);
    });
    this.#running.set(userId, run);
    return run;
  }

  /** Resolves when no run is active or queued for the user. */
  async idle(userId: string): Promise<void> {
    for (;;) {
      const t = this.#timers.get(userId);
      const r = this.#running.get(userId);
      if (!t && !r) return;
      if (r) await r;
      else await new Promise((res) => setTimeout(res, DEBOUNCE_MS + 10));
    }
  }

  async #run(userId: string): Promise<void> {
    const { db } = this.#deps;
    try {
      const user = all<{ time_zone: string }>(
        db,
        "SELECT time_zone FROM users WHERE id = ?",
        userId,
      )[0];
      if (!user) return;
      const calendars = all<{ id: string; account_id: string }>(
        db,
        `SELECT c.id, c.account_id FROM calendars c JOIN google_accounts a ON a.id = c.account_id
         WHERE a.user_id = ? AND a.status = 'ok' AND (c.check_availability = 1 OR c.is_primary = 1)`,
        userId,
      );
      for (const cal of calendars) {
        await pullEvents(db, this.apiFor(cal.account_id), cal.id, user.time_zone, this.#now());
      }
      await replanUser({ db, apiFor: (a) => this.apiFor(a), now: this.#now() }, userId);
    } catch (err) {
      this.#log(`sync failed for user ${userId}`, err);
    }
  }
}
