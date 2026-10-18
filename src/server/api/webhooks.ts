// Webhook endpoints (docs/specs/integrations-webhooks.md rules 1-6).
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app.ts";
import type { SecretBox } from "../crypto.ts";
import { all, type Db, one, run } from "../db.ts";
import { jsonBody, notFound } from "../http.ts";
import { newSecret, urlProblem } from "../webhooks.ts";

export function webhookRoutes(
  db: Db,
  box: SecretBox,
  allowPrivate: boolean,
  now: () => number,
): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.get("/webhooks", (c) =>
    c.json({
      endpoints: all<{ link_ids: string }>(
        db,
        `SELECT e.id, e.name, e.url, e.status, e.created_at,
           (SELECT COUNT(*) FROM booking_link_webhooks w WHERE w.endpoint_id = e.id) AS links,
           (SELECT json_group_array(w.link_id) FROM booking_link_webhooks w WHERE w.endpoint_id = e.id) AS link_ids,
           (SELECT last_result FROM webhook_deliveries d WHERE d.endpoint_id = e.id ORDER BY created_at DESC LIMIT 1) AS last_result
         FROM webhook_endpoints e WHERE e.user_id = ? ORDER BY e.created_at`,
        c.get("user").id,
      ).map((e) => ({ ...e, link_ids: JSON.parse(e.link_ids) as string[] })),
    }),
  );

  r.post("/webhooks", async (c) => {
    const user = c.get("user");
    const b = await jsonBody(
      c,
      z.object({
        name: z.string().trim().min(1).max(100),
        url: z.string().max(2000),
        secret: z.string().min(32).max(128).optional(),
      }),
    );
    const problem = urlProblem(b.url, allowPrivate);
    if (problem) return c.json({ error: "invalid_url", message: problem }, 400);
    const id = randomUUID();
    const secret = b.secret ?? newSecret();
    run(
      db,
      "INSERT INTO webhook_endpoints (id, user_id, name, url, secret, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      id,
      user.id,
      b.name,
      b.url,
      box.seal(secret),
      now(),
    );
    // The secret is shown once, at creation and after a regeneration.
    return c.json({ id, secret }, 201);
  });

  r.post("/webhooks/:id/secret", (c) => {
    const user = c.get("user");
    const id = c.req.param("id");
    if (!one(db, "SELECT 1 FROM webhook_endpoints WHERE id = ? AND user_id = ?", id, user.id))
      notFound("endpoint");
    const secret = newSecret();
    run(
      db,
      "UPDATE webhook_endpoints SET secret = ?, status = 'active' WHERE id = ?",
      box.seal(secret),
      id,
    );
    return c.json({ secret });
  });

  /** Rule 15: the owner resumes a suspended endpoint. */
  r.post("/webhooks/:id/resume", (c) => {
    run(
      db,
      "UPDATE webhook_endpoints SET status = 'active' WHERE id = ? AND user_id = ?",
      c.req.param("id"),
      c.get("user").id,
    );
    return c.json({ ok: true });
  });

  r.delete("/webhooks/:id", (c) => {
    run(
      db,
      "DELETE FROM webhook_endpoints WHERE id = ? AND user_id = ?",
      c.req.param("id"),
      c.get("user").id,
    );
    return c.body(null, 204);
  });

  /** Sets the endpoints a booking link sends to (rules 4-6). */
  r.put("/booking/links/:id/webhooks", async (c) => {
    const user = c.get("user");
    const linkId = c.req.param("id");
    if (!one(db, "SELECT 1 FROM booking_links WHERE id = ? AND user_id = ?", linkId, user.id))
      notFound("link");
    const { endpointIds } = await jsonBody(
      c,
      z.object({ endpointIds: z.array(z.string()).max(20) }),
    );
    run(db, "DELETE FROM booking_link_webhooks WHERE link_id = ?", linkId);
    for (const e of endpointIds) {
      if (!one(db, "SELECT 1 FROM webhook_endpoints WHERE id = ? AND user_id = ?", e, user.id))
        notFound("endpoint");
      run(db, "INSERT INTO booking_link_webhooks (link_id, endpoint_id) VALUES (?, ?)", linkId, e);
    }
    return c.json({ ok: true });
  });
  return r;
}
