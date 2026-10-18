// Account settings: added calendar accounts (accounts-login-emails-permissions.md
// rules 6-8), personal API keys (integrations-api-keys-zapier.md rules 1-5) and
// deleting the own account.
import { Hono } from "hono";
import { z } from "zod";
import { upsertAccount } from "../accounts.ts";
import { createApiKey, deleteApiKey, listApiKeys, regenerateApiKey } from "../api-keys.ts";
import type { AppEnv } from "../app.ts";
import type { SecretBox } from "../crypto.ts";
import { all, type Db, one, run, tx } from "../db.ts";
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

  /** Adds a CalDAV account to the signed-in user (rule 6). */
  r.post("/accounts", async (c) => {
    const user = c.get("user");
    const b = await jsonBody(c, caldavAccount);
    const email = (b.email ?? (b.username.includes("@") ? b.username : "")).toLowerCase();
    if (!email)
      return c.json({ error: "email_required", message: "Enter the email address." }, 400);
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
    const externalId = `${new URL(b.serverUrl).href}|${b.username}`;
    const holder = one<{ user_id: string }>(
      db,
      "SELECT user_id FROM accounts WHERE provider = 'caldav' AND external_id = ?",
      externalId,
    );
    if (holder && holder.user_id !== user.id)
      return c.json(
        {
          error: "account_in_use",
          message: "This calendar account belongs to another Tempoloom user.",
        },
        409,
      );
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
    return c.json({ id }, 201);
  });

  /** Removes an added account; the main (first) account stays (rules 7, 8). */
  r.delete("/accounts/:id", async (c) => {
    const user = c.get("user");
    const id = c.req.param("id");
    const ids = all<{ id: string }>(
      db,
      "SELECT id FROM accounts WHERE user_id = ? ORDER BY created_at",
      user.id,
    ).map((a) => a.id);
    if (!ids.includes(id)) notFound("account");
    if (ids[0] === id)
      return c.json({ error: "main_account", message: "The main account cannot be removed." }, 400);
    await sync.exclusive(user.id, async (pool) => {
      await removeManagedEvents(db, pool, user.id, now(), id);
      run(db, "DELETE FROM accounts WHERE id = ?", id);
    });
    return c.body(null, 204);
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
