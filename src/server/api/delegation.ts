// Delegated access (docs/specs/accounts-delegated-access.md): the owner's
// delegate list and search, switching into an owner's account, and the live
// change stream of an account (rule 9).
import { Hono, type MiddlewareHandler } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { AppEnv } from "../app.ts";
import type { Db } from "../db.ts";
import {
  blockedForDelegate,
  canAct,
  candidates,
  changesFor,
  DelegationError,
  delegatesOf,
  grant,
  recordChange,
  revoke,
  setActing,
} from "../delegation.ts";
import { jsonBody } from "../http.ts";
import type { LiveHub } from "../live.ts";

const KEEP_ALIVE_MS = 25_000;

export function delegationRoutes(db: Db, live: LiveHub, now: () => number): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.get("/delegates", (c) => {
    const user = c.get("user");
    return c.json({ delegates: delegatesOf(db, user.id), changes: changesFor(db, user.id) });
  });

  r.get("/delegates/search", (c) =>
    c.json({ people: candidates(db, c.get("user").id, c.req.query("q") ?? "") }),
  );

  r.post("/delegates", async (c) => {
    const { userId } = await jsonBody(c, z.object({ userId: z.string() }));
    try {
      grant(db, c.get("user").id, userId, now());
    } catch (err) {
      if (!(err instanceof DelegationError)) throw err;
      return c.json(
        { error: err.code, message: "Only members of your team can be delegates." },
        400,
      );
    }
    return c.json({ ok: true }, 201);
  });

  r.delete("/delegates/:userId", (c) => {
    revoke(db, c.get("user").id, c.req.param("userId"));
    return c.body(null, 204);
  });

  /** Switches this session into an owner's account (rule 5). */
  r.post("/acting", async (c) => {
    const session = c.get("session");
    const me = c.get("actor") ?? c.get("user");
    const { ownerId } = await jsonBody(c, z.object({ ownerId: z.string() }));
    if (!session || !canAct(db, me.id, ownerId))
      return c.json(
        { error: "no_access", message: "You do not have access to this account." },
        403,
      );
    setActing(db, session, ownerId);
    return c.json({ ok: true });
  });

  /** Ends the acting session (rule 8). */
  r.delete("/acting", (c) => {
    const session = c.get("session");
    if (session) setActing(db, session, null);
    return c.body(null, 204);
  });

  /** One stream per open page; `client` identifies the page, so it skips its own changes. */
  r.get("/live", (c) => {
    const user = c.get("user");
    const client = c.req.query("client") ?? "";
    return streamSSE(c, async (stream) => {
      // Subscribe before "ready": a change between the two is in the mark or in a signal.
      const off = live.subscribe(user.id, client, () => {
        stream.writeSSE({ event: "change", data: live.mark(user.id) }).catch(() => {});
      });
      const ping = setInterval(
        () => void stream.write(": ping\n\n").catch(() => {}),
        KEEP_ALIVE_MS,
      );
      const closed = new Promise<void>((resolve) =>
        stream.onAbort(() => {
          clearInterval(ping);
          off();
          resolve();
        }),
      );
      await stream.writeSSE({ event: "ready", data: live.mark(user.id), retry: 3000 });
      await closed;
    });
  });

  return r;
}

/** Requests that only change nothing visible: no record, no live signal. */
const QUIET = /^\/api\/(acting|live|planner\/sync)$/;

/**
 * Runs after authentication on every /api request. In an acting session it
 * blocks what stays with the owner (rule 7) and records each change (rule 11);
 * a key-authenticated request may not do those things either. Each change
 * signals the account's other open pages (rule 9).
 */
export function delegationGuard(
  db: Db,
  live: LiveHub,
  now: () => number,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const { method, path } = c.req;
    const user = c.get("user");
    const actor = c.get("actor");
    const blocked = blockedForDelegate(method, path, user.name);
    if (blocked && actor) return c.json({ error: "delegate_forbidden", message: blocked }, 403);
    if (blocked && !c.get("session"))
      return c.json(
        { error: "session_required", message: "Use the web app for this action." },
        403,
      );
    await next();
    if (method === "GET" || method === "HEAD" || QUIET.test(path) || c.res.status >= 400) return;
    if (actor) recordChange(db, user.id, actor.email, method, path, now());
    live.notify(user.id, c.req.header("x-tl-client"));
  };
}
