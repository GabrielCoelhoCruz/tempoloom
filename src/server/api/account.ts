// Account settings: added calendar accounts (accounts-login-emails-permissions.md
// rules 6-8), personal API keys (integrations-api-keys-zapier.md rules 1-5) and
// deleting the own account.
import { Hono } from "hono";
import { z } from "zod";
import { isValidTimeZone } from "../../shared/time.ts";
import { upsertAccount } from "../accounts.ts";
import { createApiKey, deleteApiKey, listApiKeys, regenerateApiKey } from "../api-keys.ts";
import type { AppEnv } from "../app.ts";
import type { SecretBox } from "../crypto.ts";
import { all, type Db, one, run, tx } from "../db.ts";
import { dropCoveredGrant } from "../grant.ts";
import { jsonBody, notFound } from "../http.ts";
import { CalDavProvider } from "../providers/caldav.ts";
import type { ProviderPool } from "../providers/index.ts";
import { ProviderError } from "../providers/types.ts";
import type { SyncService } from "../sync/service.ts";
import { isSoleAdmin, membership } from "../teams.ts";

const caldavAccount = z.object({
  serverUrl: z.url({ protocol: /^https?$/ }),
  username: z.string().min(1).max(200),
  password: z.string().min(1).max(1000),
  email: z.email().optional(),
  timeZone: z.string().refine(isValidTimeZone, "Unknown time zone").optional(),
});

/** Deletes the user's managed events that end after `from`, from the calendars. */
async function removeManagedEvents(
  db: Db,
  pool: ProviderPool,
  userId: string,
  from: number,
  accountId: string | null,
): Promise<void> {
  const rows = all<{ event_id: string; provider_id: string; account_id: string }>(
    db,
    `SELECT m.event_id, c.provider_id, c.account_id FROM managed_events m
     JOIN calendars c ON c.id = m.calendar_id
     WHERE m.user_id = ? AND m.event_id IS NOT NULL AND m.end_ms > ? AND (? IS NULL OR c.account_id = ?)`,
    userId,
    from,
    accountId,
    accountId,
  );
  for (const r of rows) {
    try {
      await pool.get(r.account_id).deleteEvent(r.provider_id, r.event_id);
    } catch (err) {
      console.error("could not delete a managed event", err);
    }
  }
}

export function accountRoutes(
  db: Db,
  box: SecretBox,
  sync: SyncService,
  now: () => number,
): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  /**
   * Adds a CalDAV account to the signed-in user (rule 6). It is also the first
   * calendar of a person who signed in with SSO or was provisioned.
   */
  r.post("/accounts", async (c) => {
    const user = c.get("user");
    const { timeZone, ...b } = await jsonBody(c, caldavAccount);
    const email = (b.email ?? (b.username.includes("@") ? b.username : user.email)).toLowerCase();
    // Check the credentials first, so nobody learns which accounts are in use.
    const probe = new CalDavProvider({ ...b, email }, "UTC");
    try {
      if ((await probe.listCalendars()).length === 0)
        return c.json({ error: "no_calendars", message: "This account has no calendars." }, 400);
    } catch (err) {
      return err instanceof ProviderError && err.kind === "auth"
        ? c.json(
            {
              error: "invalid_credentials",
              message: "The server rejected the user name or password.",
            },
            400,
          )
        : c.json(
            { error: "server_unreachable", message: "Could not reach the CalDAV server." },
            502,
          );
    }
    // An email can be a secondary email of many Tempoloom accounts (rule 4, edge case 2).
    const externalId = `${new URL(b.serverUrl).href}|${b.username}`;
    // SSO brings no time zone: the first own calendar takes the browser's, as CalDAV sign-in does.
    const first = !one(
      db,
      "SELECT 1 FROM accounts WHERE user_id = ? AND grant_team_id IS NULL",
      user.id,
    );
    if (first && timeZone)
      run(db, "UPDATE users SET time_zone = ? WHERE id = ?", timeZone, user.id);
    const id = upsertAccount(
      db,
      box,
      {
        userId: user.id,
        provider: "caldav",
        externalId,
        email,
        serverUrl: b.serverUrl,
        credentials: { username: b.username, password: b.password },
      },
      now(),
    );
    await sync.onConnect(user.id, id);
    // The person's own connection replaces the read-only copy from the team's grant.
    dropCoveredGrant(db, user.id);
    return c.json({ id }, 201);
  });

  /**
   * Removes an added account; the main email stays (rules 7, 8). Its calendars
   * go, and with them the mirroring policies that use them; the next run
   * deletes their copies (sync-calendar-mirroring.md edge case 9).
   */
  r.delete("/accounts/:id", async (c) => {
    const user = c.get("user");
    const id = c.req.param("id");
    const row = one<{ is_main: number }>(
      db,
      "SELECT is_main FROM accounts WHERE id = ? AND user_id = ? AND grant_team_id IS NULL",
      id,
      user.id,
    );
    if (!row) notFound("account");
    if (row.is_main)
      return c.json({ error: "main_account", message: "The main account cannot be removed." }, 400);
    await sync.exclusive(user.id, async (pool) => {
      await removeManagedEvents(db, pool, user.id, now(), id);
      run(db, "DELETE FROM accounts WHERE id = ?", id);
    });
    return c.body(null, 204);
  });

  /**
   * Makes an added account the main email (rules 10-13; connected calendars
   * rule 9): its primary calendar becomes the connected, locked main calendar,
   * and the old main calendar stops being connected unless a policy uses it.
   */
  r.post("/accounts/:id/main", (c) => {
    const user = c.get("user");
    const a = one<{
      id: string;
      provider: string;
      external_id: string;
      email: string;
      status: string;
      is_main: number;
    }>(
      db,
      `SELECT id, provider, external_id, email, status, is_main FROM accounts
       WHERE id = ? AND user_id = ? AND grant_team_id IS NULL AND provider <> 'ics'`,
      c.req.param("id"),
      user.id,
    );
    if (!a) notFound("account");
    if (a.is_main) return c.json({ ok: true });
    if (a.status !== "ok")
      return c.json(
        {
          error: "disconnected",
          message: `${a.email} is disconnected. Reconnect it before you make it your main email.`,
        },
        409,
      );
    const email = a.email.toLowerCase();
    const taken = one(
      db,
      `SELECT 1 FROM users u WHERE u.id <> ? AND (u.email = ? OR EXISTS (
         SELECT 1 FROM accounts o WHERE o.user_id = u.id AND o.is_main = 1
           AND o.provider = ? AND o.external_id = ?))`,
      user.id,
      email,
      a.provider,
      a.external_id,
    );
    if (taken)
      return c.json(
        {
          error: "main_email_taken",
          message: `${a.email} is the main email of another Tempoloom account. This is often an older account that you forgot. To fix it, sign in with ${a.email}, then delete that account or make another email its main email. Then sign in here again and retry.`,
        },
        409,
      );
    tx(db, () => {
      const old = one<{ id: string }>(
        db,
        `SELECT c.id FROM calendars c JOIN accounts o ON o.id = c.account_id
         WHERE o.user_id = ? AND o.is_main = 1 AND c.is_primary = 1`,
        user.id,
      );
      run(db, "UPDATE accounts SET is_main = (id = ?) WHERE user_id = ?", a.id, user.id);
      run(db, "UPDATE users SET email = ? WHERE id = ?", email, user.id);
      run(
        db,
        "UPDATE calendars SET check_availability = 1 WHERE account_id = ? AND is_primary = 1",
        a.id,
      );
      if (old)
        run(
          db,
          `UPDATE calendars SET check_availability = 0 WHERE id = ? AND NOT EXISTS (
             SELECT 1 FROM mirror_policies p WHERE p.enabled = 1
               AND (p.source_calendar_id = calendars.id OR p.dest_calendar_id = calendars.id))`,
          old.id,
        );
    });
    sync.request(user.id, 0);
    return c.json({ ok: true });
  });

  r.get("/keys", (c) => c.json({ keys: listApiKeys(db, c.get("user").id) }));

  r.post("/keys", async (c) => {
    const b = await jsonBody(
      c,
      z.object({
        name: z.string().trim().min(1).max(100),
        expires: z.enum(["30d", "90d", "1y", "never"]).default("never"),
      }),
    );
    return c.json(createApiKey(db, c.get("user").id, b, now()), 201);
  });

  r.post("/keys/:id/regenerate", (c) => {
    const secret = regenerateApiKey(db, c.get("user").id, c.req.param("id"));
    if (!secret) notFound("API key");
    return c.json({ secret });
  });

  r.delete("/keys/:id", (c) => {
    if (!deleteApiKey(db, c.get("user").id, c.req.param("id"))) notFound("API key");
    return c.body(null, 204);
  });

  /**
   * Deletes the own account: its data, and its managed events from now on.
   * The sole admin of a team with other members must hand over first.
   */
  r.delete("/me", async (c) => {
    const user = c.get("user");
    const { confirm } = await jsonBody(c, z.object({ confirm: z.string() }));
    if (confirm.trim().toLowerCase() !== user.email)
      return c.json({ error: "confirm_mismatch", message: "Type your email to confirm." }, 400);
    if (isSoleAdmin(db, user.id))
      return c.json(
        {
          error: "sole_admin",
          message:
            "You are the only admin of a team with other members. Make another member an admin before you delete your account.",
        },
        409,
      );
    const teamId = membership(db, user.id).team.id;
    await sync.exclusive(user.id, async (pool) => {
      await removeManagedEvents(db, pool, user.id, now(), null);
      tx(db, () => {
        run(db, "DELETE FROM users WHERE id = ?", user.id);
        run(
          db,
          "DELETE FROM teams WHERE id = ? AND NOT EXISTS (SELECT 1 FROM team_members WHERE team_id = ?)",
          teamId,
          teamId,
        );
      });
    });
    return c.body(null, 204);
  });

  return r;
}
