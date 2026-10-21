// Item-specific hours of booking links go with the link people that use them
// (docs/specs/planning-hours.md, item-specific hours): a hidden set that
// nothing uses any more is deleted, whichever way its link or person goes.
//
// Ways it can fail:
// 1. A group deleted with its links leaves the hidden sets of their people.
// 2. A person who leaves the team drops out of the pools, but their hidden
//    sets on those links stay.
// 3. A hidden set still in use by another link is deleted.
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { ensureUser, type User } from "../../src/server/accounts.ts";
import { bookingShareRoutes } from "../../src/server/api/booking-share.ts";
import type { AppEnv } from "../../src/server/app.ts";
import { all, openDb, run } from "../../src/server/db.ts";
import { createItemHours } from "../../src/server/item-hours.ts";
import { leaveTeam, membership } from "../../src/server/teams.ts";

const T0 = Date.parse("2026-10-19T08:00:00Z");
const TUE = { "2": [[420, 510]] };

function setup() {
  const db = openDb(":memory:");
  const owner = ensureUser(db, "owner@acme.example", "Owner", T0);
  const sam = ensureUser(db, "sam@acme.example", "Sam", T0, membership(db, owner.id).team.id);
  const link = (id: string, groupId: string | null = null) =>
    run(
      db,
      `INSERT INTO booking_links (id, user_id, slug, title, title_template, durations, level, created_at, group_id)
       VALUES (?, ?, ?, ?, '', '[30]', 2, ?, ?)`,
      id,
      owner.id,
      id,
      id,
      T0,
      groupId,
    );
  const person = (linkId: string, u: User, kind: "organizer" | "pool", setId: string) =>
    run(
      db,
      "INSERT INTO booking_link_people (link_id, user_id, kind, hours_set_id) VALUES (?, ?, ?, ?)",
      linkId,
      u.id,
      kind,
      setId,
    );
  const hidden = () =>
    all<{ id: string }>(db, "SELECT id FROM hours_sets WHERE item_specific = 1 ORDER BY id").map(
      (r) => r.id,
    );
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("user", owner);
    await next();
  });
  app.route(
    "/api/booking",
    bookingShareRoutes(db, () => T0),
  );
  return { db, owner, sam, link, person, hidden, app };
}

describe("hidden hours sets of booking links", () => {
  it("go when their group is deleted with its links", async () => {
    const { db, owner, link, person, hidden, app } = setup();
    run(
      db,
      "INSERT INTO booking_groups (id, user_id, slug, title, created_at) VALUES ('g', ?, 'g', 'G', ?)",
      owner.id,
      T0,
    );
    link("in-group", "g");
    link("kept");
    const gone = createItemHours(db, owner.id, "in-group", TUE);
    // A set that a link outside the group also uses stays.
    const both = createItemHours(db, owner.id, "kept", TUE);
    const x = ensureUser(db, "x@acme.example", "X", T0, membership(db, owner.id).team.id);
    person("in-group", owner, "organizer", gone);
    person("in-group", x, "pool", both);
    person("kept", owner, "organizer", both);
    const res = await app.request("/api/booking/groups/g?links=delete", { method: "DELETE" });
    expect(res.status).toBe(204);
    expect(hidden()).toEqual([both]);
  });

  it("go when their person leaves the team and drops out of the pool", () => {
    const { db, owner, sam, link, person, hidden } = setup();
    link("rr");
    const theirs = createItemHours(db, sam.id, "rr", TUE);
    const mine = createItemHours(db, owner.id, "rr", TUE);
    person("rr", owner, "pool", mine);
    person("rr", sam, "pool", theirs);
    leaveTeam(db, sam.id, T0);
    expect(hidden()).toEqual([mine]);
  });
});
