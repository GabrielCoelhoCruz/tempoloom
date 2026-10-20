// Library entry 32, "guests from outside only" (docs/specs/automations-library.md
// rule 12): a meeting made from the entry refuses a guest on the user's own mail
// domain or a person of the user's team.
//
// Ways it can fail:
// 1. A subscribed ICS feed named like an address (a client's calendar export)
//    makes the client's domain "own", so every guest there is refused.
// 2. A user on a public mail service (aol.com, yahoo.co.uk, gmx.net, ...) gets
//    every guest on that service refused as "on your own domain".
// 3. The refusal tells any user whether an address has an account on the
//    instance, also for people of other teams.
// 4. A guest on the user's own domain, or on the domain of an added calendar
//    account, saves.
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { ensureUser } from "../../src/server/accounts.ts";
import { meetingRoutes } from "../../src/server/api/meetings.ts";
import type { AppEnv } from "../../src/server/app.ts";
import { openDb, run } from "../../src/server/db.ts";
import type { SyncService } from "../../src/server/sync/service.ts";
import { membership } from "../../src/server/teams.ts";

const T0 = Date.parse("2026-10-19T08:00:00Z");
const WHY = "Recurring client meetings take external guests only.";

function setup(email = "owner@acme.example") {
  const db = openDb(":memory:");
  const owner = ensureUser(db, email, "Owner", T0);
  const sync = {
    request() {},
    exclusive: async (_u: string, fn: (p: unknown) => Promise<unknown>) => fn({}),
  } as unknown as SyncService;
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("user", owner);
    await next();
  });
  app.route(
    "/api",
    meetingRoutes(db, sync, () => T0),
  );
  /** The refusal message, or "saved". */
  const add = async (...guests: string[]) => {
    const res = await app.request("/api/meetings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Recurring client meetings",
        attendees: guests.map((g) => ({ email: g })),
        frequency: { period: "weekly", everyWeeks: 1, idealDays: [2] },
        idealTime: "10:00",
        durationMinutes: 30,
        externalOnly: true,
      }),
    });
    if (res.ok) return "saved";
    return JSON.stringify(await res.json());
  };
  const account = (provider: string, accountEmail: string) =>
    run(
      db,
      `INSERT INTO accounts (id, user_id, provider, external_id, email, credentials, status, created_at, is_main)
       VALUES (?, ?, ?, ?, ?, '', 'ok', ?, 0)`,
      `${provider}-${accountEmail}`,
      owner.id,
      provider,
      accountEmail,
      accountEmail,
      T0,
    );
  return { db, owner, add, account };
}

describe("library entry 32: guests from outside only", () => {
  it("refuses a guest on the user's own domain and on the domain of an added calendar account", async () => {
    const { add, account } = setup();
    expect(await add("lee@acme.example")).toContain(
      `lee@acme.example is on your own domain. ${WHY}`,
    );
    account("caldav", "me@side.example");
    expect(await add("kim@side.example")).toContain("kim@side.example is on your own domain.");
    expect(await add("client@example.com")).toBe("saved");
  });

  it("does not take the name of a subscribed ICS feed as an own mail domain", async () => {
    const { add, account } = setup();
    account("ics", "jane@client.example");
    expect(await add("jane@client.example", "bob@client.example")).toBe("saved");
  });

  it.each([
    ["owner@aol.com", "client@aol.com"],
    ["owner@yahoo.co.uk", "client@yahoo.co.uk"],
    ["owner@yahoo.fr", "client@yahoo.fr"],
    ["owner@gmx.net", "client@gmx.net"],
    ["owner@gmx.at", "client@gmx.at"],
    ["owner@yandex.ru", "client@yandex.ru"],
    ["owner@zoho.com", "client@zoho.com"],
    ["owner@pm.me", "client@pm.me"],
    ["owner@fastmail.com", "client@fastmail.com"],
    ["owner@mail.com", "client@mail.com"],
    ["owner@hotmail.co.uk", "client@hotmail.co.uk"],
    ["owner@outlook.de", "client@outlook.de"],
  ])("a user at %s may invite %s: a public mail service is no own domain", async (me, guest) => {
    const { add } = setup(me);
    expect(await add(guest)).toBe("saved");
  });

  it("refuses a person of the user's team, and says nothing about users of other teams", async () => {
    const { db, owner, add } = setup();
    // A user of this instance in another team: the requester cannot see them.
    ensureUser(db, "pat@partner.example", "Pat", T0);
    expect(await add("pat@partner.example")).toBe("saved");
    // A person of the user's own team on another domain.
    ensureUser(db, "sam@freelance.example", "Sam", T0, membership(db, owner.id).team.id);
    expect(await add("sam@freelance.example")).toContain(
      `sam@freelance.example is in your team. ${WHY}`,
    );
  });
});
