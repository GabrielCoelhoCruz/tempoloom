// The public share page of a weekly report (docs/specs/analytics-weekly-reports.md
// rules 10-12), against an in-memory database. The E2E suite covers the journey;
// these cover the privacy cases the E2E user cannot have.
//
// Ways it can fail:
// 1. The page shows an email address, or a login name that is not a display
//    name the user set (a CalDAV user name, often an email or its local part).
// 2. A plain GET of an email link (a mail scanner) makes the page public, or a
//    POST from another site does.
// 3. Search engines may index the page or the not-found answer.
// 4. The owner cannot stop sharing, or another user can.
// 5. One client (or a proxy that all visitors share) makes share pages answer
//    429 for everyone, or the publish POST of one share has no limit.
// 6. A directory login name (SCIM userName, when the directory sends no
//    display name) shows.
// 7. The publish limit counts per proxy, so all visitors behind it share one
//    limit, or it trusts an X-Forwarded-For that an untrusted client sends.
// 8. Rows are never removed: unshared and stopped shares stay, and shared
//    pages stay for ever (pruned by the email worker's run).
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSession, ensureUser } from "../../src/server/accounts.ts";
import { createApp } from "../../src/server/app.ts";
import { loadConfig } from "../../src/server/config.ts";
import { SecretBox } from "../../src/server/crypto.ts";
import { DailyMailWorker } from "../../src/server/daily-mail.ts";
import { all, openDb, run } from "../../src/server/db.ts";
import type { Mailer } from "../../src/server/mail.ts";
import type { SyncService } from "../../src/server/sync/service.ts";
import type { WebhookWorker } from "../../src/server/webhooks.ts";
import { weeklyReport } from "../../src/server/weekly-report.ts";

const T0 = Date.parse("2026-11-13T08:30:00Z");
const BASE = "http://localhost:8787";
const PROXY = "10.0.0.1";

function setup(user: { email: string; name: string; caldavUser?: string; scimUser?: string }) {
  const key = randomBytes(32).toString("base64");
  const db = openDb(":memory:");
  const box = new SecretBox(key);
  const u = ensureUser(db, user.email, user.name, T0);
  if (user.caldavUser)
    run(
      db,
      "INSERT INTO accounts (id, user_id, provider, external_id, email, server_url, credentials, created_at) VALUES (?, ?, 'caldav', ?, ?, ?, '', ?)",
      randomUUID(),
      u.id,
      `https://dav.example.com/|${user.caldavUser}`,
      user.email,
      "https://dav.example.com/",
      T0,
    );
  if (user.scimUser) {
    run(
      db,
      "INSERT INTO teams (id, name, domain, created_at) VALUES ('t1', 'Corp', 'corp.example', ?)",
      T0,
    );
    run(
      db,
      "INSERT INTO directory_profiles (user_id, team_id, resource, created_at, updated_at) VALUES (?, 't1', ?, ?, ?)",
      u.id,
      JSON.stringify({ userName: user.scimUser, emails: [{ value: user.email, primary: true }] }),
      T0,
      T0,
    );
  }
  const config = loadConfig({
    SECRET_KEY: key,
    DATA_DIR: mkdtempSync(join(tmpdir(), "tl-share-")),
    BASE_URL: BASE,
    TRUSTED_PROXIES: PROXY,
  });
  const app = createApp({
    db,
    config,
    box,
    oauth: undefined,
    sync: { onConnect: async () => {}, onChange: () => {} } as unknown as SyncService,
    webhooks: {} as WebhookWorker,
    mailer: { configured: false, send: async () => {} } as Mailer,
    now: () => T0,
  });
  const report = weeklyReport(
    db,
    { id: u.id, email: user.email, time_zone: "Europe/Berlin" },
    { from: "2026-11-09", to: "2026-11-13" },
    BASE,
    T0,
  );
  const link = (label: string) =>
    new URL(report.text.match(new RegExp(`^${label}: (\\S+)$`, "m"))?.[1] ?? "").pathname +
    (label === "Direct link" ? "?to=link" : `?to=${label.toLowerCase()}`);
  const direct = link("Direct link");
  const pagePath = direct.replace(/\/share\?to=link$/, "");
  const cookie = `tl_session=${createSession(db, u.id, T0)}`;
  /** Opens the share link, then confirms it with the form's token, as a browser does. */
  const share = async (path = direct) => {
    const confirm = await app.request(path);
    expect(confirm.status).toBe(200);
    const html = await confirm.text();
    const csrf = html.match(/name="csrf" value="([^"]+)"/)?.[1] ?? "";
    const set = confirm.headers.get("set-cookie") ?? "";
    const res = await app.request(new URL(path, BASE).pathname, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: set.split(";")[0] ?? "",
        origin: BASE,
      },
      body: new URLSearchParams({ to: new URL(path, BASE).searchParams.get("to") ?? "", csrf }),
    });
    return res;
  };
  /** Another week's report of the same user: its direct share link. */
  const another = () => {
    const r = weeklyReport(
      db,
      { id: u.id, email: user.email, time_zone: "Europe/Berlin" },
      { from: "2026-11-16", to: "2026-11-20" },
      BASE,
      T0,
    );
    return `${new URL(r.text.match(/^Direct link: (\S+)$/m)?.[1] ?? "").pathname}?to=link`;
  };
  return { db, app, u, direct, pagePath, cookie, share, link, another };
}

describe("weekly report share page (rules 10-12)", () => {
  it("shows no name when the user's name is an email address", async () => {
    const s = setup({ email: "ana@example.com", name: "ana.lima@example.com" });
    expect((await s.share()).status).toBe(303);
    const res = await s.app.request(s.pagePath);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain("@");
    expect(html).not.toContain("ana.lima");
    expect(html).toContain("2026-11-09 to 2026-11-13");
  });

  it("shows no name when the name is the CalDAV user name or the email's local part", async () => {
    for (const user of [
      { email: "ana@example.com", name: "ana" },
      { email: "ana@example.com", name: "alima", caldavUser: "alima" },
    ]) {
      const s = setup(user);
      await s.share();
      const html = await (await s.app.request(s.pagePath)).text();
      expect(html).not.toContain(user.name);
      expect(html).not.toContain("ana@example.com");
    }
  });

  it("shows a display name the user set", async () => {
    const s = setup({ email: "ana@example.com", name: "Ana Lima" });
    await s.share();
    const html = await (await s.app.request(s.pagePath)).text();
    expect(html).toContain("<h1>Ana Lima's week</h1>");
    // A visitor reads the title: the owner's week, not "your week".
    expect(html).toContain("<title>Ana Lima's week</title>");
    expect(html.toLowerCase()).not.toContain("your week");
    expect(html).not.toContain("ana@example.com");
  });

  it("a GET of a share link does not make the page public; the confirm form does", async () => {
    const s = setup({ email: "ana@example.com", name: "Ana Lima" });
    for (const path of [s.direct, s.link("X"), s.link("LinkedIn"), s.link("Facebook")]) {
      const res = await s.app.request(path);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('method="post"');
    }
    expect((await s.app.request(s.pagePath)).status).toBe(404);
    // Without the form's token, or from another site: refused.
    const bare = await s.app.request(new URL(s.direct, BASE).pathname, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ to: "link", csrf: "x" }),
    });
    expect(bare.status).toBe(403);
    expect((await s.app.request(s.pagePath)).status).toBe(404);
    const res = await s.share(s.link("X"));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(
      `https://twitter.com/intent/tweet?url=${encodeURIComponent(BASE + s.pagePath)}`,
    );
    expect((await s.app.request(s.pagePath)).status).toBe(200);
  });

  it("the page, the confirm page and not found are noindex, with no referrer", async () => {
    const s = setup({ email: "ana@example.com", name: "Ana Lima" });
    const confirm = await s.app.request(s.direct);
    const missing = await s.app.request(s.pagePath);
    await s.share();
    const shown = await s.app.request(s.pagePath);
    for (const res of [confirm, missing, shown]) {
      expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
      expect(await res.text()).toContain('<meta name="robots" content="noindex, nofollow">');
    }
  });

  it("the owner can stop sharing; another user cannot", async () => {
    const s = setup({ email: "ana@example.com", name: "Ana Lima" });
    await s.share();
    const list = await s.app.request("/api/weekly-shares", { headers: { cookie: s.cookie } });
    const { shares } = (await list.json()) as {
      shares: { id: string; weekFrom: string; weekTo: string; url: string }[];
    };
    expect(shares).toEqual([
      expect.objectContaining({
        weekFrom: "2026-11-09",
        weekTo: "2026-11-13",
        url: BASE + s.pagePath,
      }),
    ]);
    const id = shares[0]?.id ?? "";
    const other = ensureUser(s.db, "ben@example.com", "Ben", T0);
    const otherCookie = `tl_session=${createSession(s.db, other.id, T0)}`;
    const stop = (cookie: string) =>
      s.app.request(`/api/weekly-shares/${id}/stop`, {
        method: "POST",
        headers: { cookie, origin: BASE },
      });
    expect((await stop(otherCookie)).status).toBe(404);
    expect((await s.app.request(s.pagePath)).status).toBe(200);
    expect((await stop(s.cookie)).status).toBe(200);
    expect((await s.app.request(s.pagePath)).status).toBe(404);
    const after = await s.app.request("/api/weekly-shares", { headers: { cookie: s.cookie } });
    expect(((await after.json()) as { shares: unknown[] }).shares).toEqual([]);
  });

  it("shows no directory login name when the directory sends no display name", async () => {
    const s = setup({ email: "ana.lima@corp.example", name: "alima", scimUser: "alima" });
    await s.share();
    const html = await (await s.app.request(s.pagePath)).text();
    expect(html).not.toContain("alima");
    expect(html).toContain("<h1>A week in review</h1>");
  });

  it("serves many page views from one address: no shared limit on the public pages", async () => {
    const s = setup({ email: "ana@example.com", name: "Ana Lima" });
    await s.share();
    const codes: number[] = [];
    for (let i = 0; i < 150; i++) codes.push((await s.app.request(s.pagePath)).status);
    for (let i = 0; i < 150; i++) codes.push((await s.app.request("/r/nothing")).status);
    expect(codes.slice(0, 150).every((c) => c === 200)).toBe(true);
    expect(codes.slice(150).every((c) => c === 404)).toBe(true);
    expect((await s.app.request(s.direct)).status).toBe(302);
  });

  it("limits the publish POSTs per share, so a flood on one share does not block another", async () => {
    const s = setup({ email: "ana@example.com", name: "Ana Lima" });
    const post = () =>
      s.app.request(new URL(s.direct, BASE).pathname, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ to: "link", csrf: "wrong" }),
      });
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) codes.push((await post()).status);
    expect(codes.slice(0, 10).every((c) => c === 403)).toBe(true);
    expect(codes[10]).toBe(429);
    // The flooded share's page view still answers; another share publishes.
    expect((await s.app.request(s.pagePath)).status).toBe(404);
    const other = s.another();
    const res = await s.share(other);
    expect(res.status).toBe(303);
    expect((await s.app.request(other.replace(/\/share\?to=link$/, ""))).status).toBe(200);
  });

  it("limits the publish POSTs per client address: behind the trusted proxy each client has its own limit; a forged X-Forwarded-For does not give a new one", async () => {
    const s = setup({ email: "ana@example.com", name: "Ana Lima" });
    const post = (peer: string, forwarded?: string) =>
      s.app.request(
        new URL(s.direct, BASE).pathname,
        {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            ...(forwarded ? { "x-forwarded-for": forwarded } : {}),
          },
          body: new URLSearchParams({ to: "link", csrf: "wrong" }),
        },
        { incoming: { socket: { remoteAddress: peer } } },
      );
    // Client A through the proxy uses up its limit.
    for (let i = 0; i < 10; i++) expect((await post(PROXY, "203.0.113.5")).status).toBe(403);
    expect((await post(PROXY, "203.0.113.5")).status).toBe(429);
    // Client B through the same proxy has its own limit.
    expect((await post(PROXY, "203.0.113.6")).status).toBe(403);
    // A client that is not the proxy cannot pick a new address with the header.
    for (let i = 0; i < 10; i++)
      expect((await post("198.51.100.7", `192.0.2.${i}`)).status).toBe(403);
    expect((await post("198.51.100.7", "192.0.2.99")).status).toBe(429);
    expect((await post("198.51.100.7")).status).toBe(429);
  });

  it("prunes unshared and stopped shares 2 weeks after their week, and shared pages 13 weeks after it, in the email worker's run", async () => {
    const s = setup({ email: "ana@example.com", name: "Ana Lima" });
    const tick = (at: string) =>
      new DailyMailWorker({
        db: s.db,
        mailer: { configured: false, send: async () => {} },
        now: () => Date.parse(at),
        baseUrl: BASE,
        intervalMs: 60_000,
      }).tick();
    const status = async (path: string) => (await s.app.request(path)).status;
    expect((await s.share()).status).toBe(303);
    // Week 2026-11-16 to 11-20: never shared.
    const unshared = s.another();
    // Week 2026-11-23 to 11-27: shared, then stopped.
    const stopped = weeklyReport(
      s.db,
      { id: s.u.id, email: "ana@example.com", time_zone: "Europe/Berlin" },
      { from: "2026-11-23", to: "2026-11-27" },
      BASE,
      T0,
    );
    const stoppedPath = `${new URL(stopped.text.match(/^Direct link: (\S+)$/m)?.[1] ?? "").pathname}?to=link`;
    expect((await s.share(stoppedPath)).status).toBe(303);
    run(s.db, "UPDATE weekly_shares SET shared_at = NULL WHERE week_from = '2026-11-23'");
    const weeks = () =>
      all<{ week_from: string }>(
        s.db,
        "SELECT week_from FROM weekly_shares ORDER BY week_from",
      ).map((r) => r.week_from);

    // 13 days after 11-20: nothing is old enough.
    await tick("2026-12-03T12:00:00Z");
    expect(weeks()).toEqual(["2026-11-09", "2026-11-16", "2026-11-23"]);
    // 15 days after 11-20: the unshared week goes; its share link is "not found".
    await tick("2026-12-05T12:00:00Z");
    expect(weeks()).toEqual(["2026-11-09", "2026-11-23"]);
    expect(await status(unshared)).toBe(404);
    // 15 days after 11-27: the stopped share goes; the shared page stays.
    await tick("2026-12-12T12:00:00Z");
    expect(weeks()).toEqual(["2026-11-09"]);
    expect(await status(stoppedPath)).toBe(404);
    expect(await status(s.pagePath)).toBe(200);
    // 13 weeks after 11-13 the shared page stays; one day later it is "not found".
    await tick("2027-02-12T12:00:00Z");
    expect(await status(s.pagePath)).toBe(200);
    await tick("2027-02-13T12:00:00Z");
    expect(await status(s.pagePath)).toBe(404);
    expect(weeks()).toEqual([]);
  });
});
