// An account is marked disconnected when its server rejects the stored login
// (accounts-login-emails-permissions.md rules 14-16), against an in-memory
// database and a local CalDAV server that answers 401.
//
// Ways it can fail:
// 1. A sync that started with the old login gets its 401 after the user has
//    reconnected with a new login, and marks the reconnected account
//    disconnected again.
// 2. A 401 for the login that is still stored does not mark it.
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ensureUser, upsertAccount } from "../../src/server/accounts.ts";
import { SecretBox } from "../../src/server/crypto.ts";
import { one, openDb, run } from "../../src/server/db.ts";
import { SyncService } from "../../src/server/sync/service.ts";

const T0 = Date.parse("2026-10-19T08:00:00Z");

let server: Server | undefined;
afterEach(() => server?.close());

/** A CalDAV server that holds each request until `release` and then answers 401. */
async function rejectingServer() {
  let release = () => {};
  const held = new Promise<void>((r) => {
    release = r;
  });
  let seen = () => {};
  const first = new Promise<void>((r) => {
    seen = r;
  });
  server = createServer((req, res) => {
    seen();
    req.resume();
    void held.then(() => {
      res.writeHead(401, { "www-authenticate": 'Basic realm="x"' });
      res.end();
    });
  });
  await new Promise<void>((r) => server?.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  return { url, release, first };
}

function setup(serverUrl: string) {
  const db = openDb(":memory:");
  const box = new SecretBox(randomBytes(32).toString("base64"));
  const user = ensureUser(db, "owner@example.com", "Owner", T0);
  const id = upsertAccount(db, box, {
    userId: user.id,
    provider: "caldav",
    externalId: "owner",
    email: "owner@example.com",
    serverUrl,
    credentials: { username: "owner", password: "old" },
  });
  const sync = new SyncService({
    db,
    box,
    oauth: undefined,
    serviceKey: undefined,
    now: () => T0,
    intervalMs: 60_000,
    baseUrl: "http://localhost",
    log: () => {},
  });
  const status = () =>
    one<{ status: string }>(db, "SELECT status FROM accounts WHERE id = ?", id)?.status;
  return { db, box, user, id, sync, status };
}

describe("account disconnect on a rejected login", () => {
  it("keeps a reconnect that happened while a sync with the old login was running", async () => {
    const srv = await rejectingServer();
    const { db, box, user, id, sync, status } = setup(srv.url);
    const running = sync.runNow(user.id);
    await srv.first;
    // The user reconnects with a new password while the old request is open.
    run(
      db,
      "UPDATE accounts SET credentials = ?, status = 'ok' WHERE id = ?",
      box.seal(JSON.stringify({ username: "owner", password: "new" })),
      id,
    );
    srv.release();
    await running;
    expect(status()).toBe("ok");
  });

  it("marks the account when the stored login is rejected", async () => {
    const srv = await rejectingServer();
    const { user, sync, status } = setup(srv.url);
    srv.release();
    await sync.runNow(user.id);
    expect(status()).toBe("reauth_required");
  });
});
