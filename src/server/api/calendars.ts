// Connected calendars (docs/specs/accounts-connected-calendars.md rules 1-8,
// 28-30): the list with locked calendars and categories, calendars shared by
// URL, and holiday feeds (events-out-of-office.md rule 11).
import { Hono } from "hono";
import { z } from "zod";
import { upsertAccount } from "../accounts.ts";
import type { AppEnv } from "../app.ts";
import type { SecretBox } from "../crypto.ts";
import { all, type Db, one, run } from "../db.ts";
import { jsonBody, notFound } from "../http.ts";
import { connectedCount, enforceCalendarLimit, limitRefusal } from "../limits.ts";
import { CalDavProvider } from "../providers/caldav.ts";
import { feedName, fetchFeed } from "../providers/ics.ts";
import type { SyncService } from "../sync/service.ts";
import { urlProblem } from "../webhooks.ts";

export interface CalendarListRow {
  id: string;
  name: string;
  is_primary: number;
  writable: number;
  check_availability: number;
  category: string;
  provider: string;
  email: string;
  account_id: string;
  provider_id: string;
  /** The main calendar: the primary calendar of the main email. */
  main: number;
  /** Always connected: the main calendar, or a calendar of an enabled mirroring policy. */
  locked: number;
  /** Added by URL: someone shared it with the account. */
  shared: number;
}

/**
 * The calendars the user can pick: full read and write access only (rule 4),
 * plus holiday feeds, and each calendar once, under the account added first
 * (rule 6). Calendars attached through a team's grant are not listed.
 */
export function listedCalendars(db: Db, userId: string): CalendarListRow[] {
  const rows = all<CalendarListRow>(
    db,
    `SELECT c.id, c.name, c.is_primary, c.writable, c.check_availability, c.category, a.provider,
       a.email, c.account_id, c.provider_id, (a.is_main = 1 AND c.is_primary = 1) AS main,
       (a.is_main = 1 AND c.is_primary = 1) OR EXISTS (SELECT 1 FROM mirror_policies p
         WHERE p.enabled = 1 AND (p.source_calendar_id = c.id OR p.dest_calendar_id = c.id)) AS locked,
       EXISTS (SELECT 1 FROM shared_calendars s
         WHERE s.account_id = c.account_id AND s.url = c.provider_id) AS shared
     FROM calendars c JOIN accounts a ON a.id = c.account_id
     WHERE a.user_id = ? AND a.grant_team_id IS NULL
     ORDER BY a.created_at, c.is_primary DESC, c.name`,
    userId,
  );
  const seen = new Set<string>();
  return rows.filter((c) => {
    if (!c.writable && c.provider !== "ics") return false;
    const key = `${c.provider === "ics" ? "ics" : "cal"}:${c.provider_id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const ownCalDav = (db: Db, userId: string, accountId: string) =>
  one<{ id: string }>(
    db,
    "SELECT id FROM accounts WHERE id = ? AND user_id = ? AND provider = 'caldav' AND grant_team_id IS NULL",
    accountId,
    userId,
  );

export function calendarRoutes(deps: {
  db: Db;
  box: SecretBox;
  sync: SyncService;
  allowPrivate: boolean;
  now: () => number;
}): Hono<AppEnv> {
  const { db, box, sync, now } = deps;
  const r = new Hono<AppEnv>();

  r.get("/calendars", (c) => {
    const user = c.get("user");
    // A lower instance limit turns extra calendars off (plans edge case 1).
    if (enforceCalendarLimit(db, user.id) > 0) sync.request(user.id);
    return c.json({ calendars: listedCalendars(db, user.id) });
  });

  /** Reads each account's calendar list again, and each holiday feed. */
  r.post("/calendars/refresh", async (c) => {
    const user = c.get("user");
    run(
      db,
      `UPDATE calendars SET sync_token = NULL WHERE account_id IN (
         SELECT id FROM accounts WHERE user_id = ? AND provider = 'ics')`,
      user.id,
    );
    await sync.refreshCalendars(user.id);
    return c.json({ ok: true });
  });

  r.patch("/calendars/:id", async (c) => {
    const user = c.get("user");
    const body = await jsonBody(
      c,
      z.object({
        checkAvailability: z.boolean().optional(),
        category: z.enum(["business", "personal", "travel"]).optional(),
      }),
    );
    const cal = listedCalendars(db, user.id).find((x) => x.id === c.req.param("id"));
    if (!cal) notFound("calendar");
    if (body.checkAvailability === false && cal.locked)
      return c.json(
        {
          error: "calendar_locked",
          message:
            "This calendar is always connected: it is the main calendar or a mirroring policy uses it.",
        },
        400,
      );
    if (body.checkAvailability && !cal.check_availability) {
      const refused = limitRefusal(db, "max_connected_calendars", connectedCount(db, user.id));
      if (refused) return c.json(refused, 409);
    }
    if (body.checkAvailability !== undefined)
      run(
        db,
        "UPDATE calendars SET check_availability = ? WHERE id = ?",
        body.checkAvailability ? 1 : 0,
        cal.id,
      );
    if (body.category)
      run(db, "UPDATE calendars SET category = ? WHERE id = ?", body.category, cal.id);
    sync.request(user.id);
    return c.json({ ok: true });
  });

  /** Adds a calendar that someone shared with a CalDAV account, by its URL (rule 30). */
  r.post("/accounts/:id/shared-calendars", async (c) => {
    const user = c.get("user");
    const accountId = c.req.param("id");
    if (!ownCalDav(db, user.id, accountId)) notFound("account");
    const { url } = await jsonBody(c, z.object({ url: z.url({ protocol: /^https?$/ }) }));
    const provider = sync.pool(user.id).get(accountId);
    if (!(provider instanceof CalDavProvider)) notFound("account");
    const found = await provider.describe(new URL(url).toString()).catch(() => null);
    if (!found || found.access === "none")
      return c.json(
        {
          error: "not_a_calendar",
          message: "Tempoloom could not open a calendar at this address with this account.",
        },
        400,
      );
    if (found.access !== "write")
      return c.json(
        {
          error: "read_only",
          message:
            "Tempoloom needs read and write access to this calendar. This calendar is shared with you read-only.",
        },
        400,
      );
    run(
      db,
      "INSERT OR IGNORE INTO shared_calendars (account_id, url) VALUES (?, ?)",
      accountId,
      new URL(url).toString(),
    );
    await sync.onConnect(user.id, accountId);
    return c.json({ ok: true }, 201);
  });

  /**
   * Adds a holiday feed: an iCalendar URL whose days block time like time away
   * (events-out-of-office.md rule 11). Its calendar is connected at once.
   */
  r.post("/holiday-feeds", async (c) => {
    const user = c.get("user");
    const { url } = await jsonBody(c, z.object({ url: z.string().trim().min(1).max(2000) }));
    const problem = urlProblem(url.replace(/^webcal:/i, "https:"), deps.allowPrivate);
    if (problem) return c.json({ error: "invalid_url", message: `${problem}.` }, 400);
    const refused = limitRefusal(db, "max_connected_calendars", connectedCount(db, user.id));
    if (refused) return c.json(refused, 409);
    let text: string;
    try {
      text = await fetchFeed(url);
    } catch {
      return c.json(
        {
          error: "feed_unreadable",
          message: "Tempoloom could not read an iCalendar feed at this address.",
        },
        400,
      );
    }
    const id = upsertAccount(
      db,
      box,
      {
        userId: user.id,
        provider: "ics",
        externalId: url,
        email: feedName(text, url),
        credentials: {},
      },
      now(),
    );
    await sync.onConnect(user.id, id);
    run(db, "UPDATE calendars SET check_availability = 1 WHERE account_id = ?", id);
    sync.request(user.id, 0);
    return c.json({ id }, 201);
  });

  return r;
}
