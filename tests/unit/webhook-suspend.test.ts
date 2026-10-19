// Suspension and resume of a webhook endpoint (integrations-webhooks.md rule 15),
// against an in-memory database and a local receiver that always answers 500.
//
// Ways it can fail:
// 1. Resume rewrites when the waiting deliveries were made, so their age is lost.
// 2. Resume of an active endpoint moves its waiting deliveries.
// 3. A failure right after a resume suspends the endpoint again, because the
//    period is measured from the oldest waiting delivery, not from the resume.
// 4. The suspension email holds the delivery loop: a slow mail server stops
//    every other webhook.
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { ensureUser } from "../../src/server/accounts.ts";
import { webhookRoutes } from "../../src/server/api/webhooks.ts";
import type { AppEnv } from "../../src/server/app.ts";
import { SecretBox } from "../../src/server/crypto.ts";
import { one, openDb, run } from "../../src/server/db.ts";
import type { Mailer } from "../../src/server/mail.ts";
import { membership } from "../../src/server/teams.ts";
import { deliverDue } from "../../src/server/webhooks.ts";

const T0 = Date.parse("2026-10-19T08:00:00Z");
const DAY = 86_400_000;

let server: Server | undefined;
afterEach(() => server?.close());

async function failingReceiver() {
  server = createServer((req, res) => {
    req.resume();
    res.writeHead(500);
    res.end();
  });
  await new Promise<void>((r) => server?.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
}

async function setup(status: "active" | "suspended", mailer?: Mailer) {
  const db = openDb(":memory:");
  const box = new SecretBox(randomBytes(32).toString("base64"));
  const user = ensureUser(db, "admin@example.com", "Admin", T0);
  const team = membership(db, user.id).team.id;
  let now = T0 + 2 * DAY;
  run(
    db,
    `INSERT INTO webhook_endpoints (id, user_id, team_id, name, url, secret, status, created_at)
     VALUES ('ep', ?, ?, 'Hook', ?, ?, ?, ?)`,
    user.id,
    team,
    await failingReceiver(),
    box.seal("secret"),
    status,
    T0,
  );
  run(
    db,
    `INSERT INTO webhook_deliveries (id, endpoint_id, type, event_ts, payload, status, next_attempt_at, created_at)
     VALUES ('d1', 'ep', 'booking.created', ?, '{}', 'pending', ?, ?)`,
    T0,
    T0 + 3 * DAY,
    T0,
  );
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("user", user);
    await next();
  });
  app.route(
    "/api",
    webhookRoutes(db, box, true, () => now),
  );
  const deps = {
    db,
    box,
    allowPrivate: true,
    retryBaseMs: 60_000,
    now: () => now,
    ...(mailer ? { mailer } : {}),
  };
  const delivery = () =>
    one<{ created_at: number; next_attempt_at: number }>(
      db,
      "SELECT created_at, next_attempt_at FROM webhook_deliveries WHERE id = 'd1'",
    );
  const endpoint = () =>
    one<{ status: string }>(db, "SELECT status FROM webhook_endpoints WHERE id = 'ep'")?.status;
  return {
    db,
    deps,
    delivery,
    endpoint,
    setNow: (t: number) => {
      now = t;
    },
    resume: () => app.request("/api/webhooks/ep/resume", { method: "POST" }),
  };
}

describe("webhook suspension", () => {
  it("resume keeps the age of the waiting deliveries and sends them now", async () => {
    const s = await setup("suspended");
    expect((await s.resume()).status).toBe(200);
    expect(s.endpoint()).toBe("active");
    expect(s.delivery()).toEqual({ created_at: T0, next_attempt_at: T0 + 2 * DAY });
  });

  it("resume of an active endpoint changes nothing", async () => {
    const s = await setup("active");
    await s.resume();
    expect(s.delivery()).toEqual({ created_at: T0, next_attempt_at: T0 + 3 * DAY });
  });

  it("a failure right after a resume does not suspend again; a full period of failures does", async () => {
    const s = await setup("suspended");
    await s.resume();
    await deliverDue(s.deps);
    expect(s.endpoint()).toBe("active");
    s.setNow(T0 + 3 * DAY + 1000);
    await deliverDue(s.deps);
    expect(s.endpoint()).toBe("suspended");
  });

  it("does not wait for the suspension email", async () => {
    const sent: string[] = [];
    const mailer: Mailer = {
      configured: true,
      send: (m) => {
        sent.push(m.to);
        return new Promise(() => {});
      },
    };
    const s = await setup("active", mailer);
    s.setNow(T0 + 3 * DAY);
    const done = await Promise.race([
      deliverDue(s.deps).then(() => "done"),
      new Promise((r) => setTimeout(() => r("held"), 2000)),
    ]);
    expect(done).toBe("done");
    expect(s.endpoint()).toBe("suspended");
    expect(sent).toEqual(["admin@example.com"]);
  });
});
