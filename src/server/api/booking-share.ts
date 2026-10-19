// Sharing booking links (docs/specs/booking-links-sharing.md): link groups,
// booking pages of their own that list chosen links (rules 1-7), and each
// user's last shared-times template and embed redirect mode (rules 20, 25).
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app.ts";
import { all, type Db, one, run, tx } from "../db.ts";
import { jsonBody, notFound } from "../http.ts";
import { pageSlugTaken, slugify } from "./booking.ts";

interface GroupRow {
  id: string;
  user_id: string;
  slug: string;
  title: string;
  branding: string;
}

const slugRe = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

const groupInput = z.object({
  title: z.string().trim().min(1).max(120),
  slug: z.string().regex(slugRe).optional(),
  linkIds: z.array(z.string()).max(200),
});

export function bookingShareRoutes(db: Db, now: () => number): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  const own = (id: string, userId: string) => {
    const g = one<GroupRow>(
      db,
      "SELECT * FROM booking_groups WHERE id = ? AND user_id = ?",
      id,
      userId,
    );
    if (!g) notFound("group");
    return g;
  };
  /** Puts exactly `linkIds` (the user's own links) in the group; others go back to the main page. */
  const setLinks = (userId: string, groupId: string, linkIds: string[]) => {
    run(db, "UPDATE booking_links SET group_id = NULL WHERE group_id = ?", groupId);
    for (const id of linkIds) {
      run(
        db,
        `UPDATE booking_links SET group_id = ?, hidden = 0
         WHERE id = ? AND user_id = ? AND source_id IS NULL`,
        groupId,
        id,
        userId,
      );
    }
  };

  r.post("/groups", async (c) => {
    const user = c.get("user");
    const b = await jsonBody(c, groupInput);
    const slug = b.slug ?? slugify(b.title);
    if (pageSlugTaken(db, slug, {})) return c.json({ error: "slug_taken" }, 409);
    // A new group copies the team's branding default, like a new page (booking page rule 28).
    const branding =
      one<{ mode: string }>(
        db,
        "SELECT b.mode FROM team_branding b JOIN team_members m ON m.team_id = b.team_id WHERE m.user_id = ?",
        user.id,
      )?.mode ?? "default";
    const id = randomUUID();
    tx(db, () => {
      run(
        db,
        "INSERT INTO booking_groups (id, user_id, slug, title, branding, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        id,
        user.id,
        slug,
        b.title,
        branding,
        now(),
      );
      setLinks(user.id, id, b.linkIds);
    });
    return c.json({ id, slug }, 201);
  });

  r.patch("/groups/:id", async (c) => {
    const user = c.get("user");
    const g = own(c.req.param("id"), user.id);
    const b = await jsonBody(
      c,
      groupInput.partial().extend({ branding: z.enum(["default", "none", "custom"]).optional() }),
    );
    if (b.slug && b.slug !== g.slug && pageSlugTaken(db, b.slug, { groupId: g.id }))
      return c.json({ error: "slug_taken" }, 409);
    tx(db, () => {
      run(
        db,
        "UPDATE booking_groups SET title = ?, slug = ?, branding = ? WHERE id = ?",
        b.title ?? g.title,
        b.slug ?? g.slug,
        b.branding ?? g.branding,
        g.id,
      );
      if (b.linkIds) setLinks(user.id, g.id, b.linkIds);
    });
    return c.json({ ok: true });
  });

  /** Rule 6: move the links to another page first, or delete them with the group. */
  r.delete("/groups/:id", (c) => {
    const user = c.get("user");
    const g = own(c.req.param("id"), user.id);
    const q = z
      .object({ links: z.enum(["move", "delete"]), to: z.string().optional() })
      .safeParse(c.req.query());
    if (!q.success) return c.json({ error: "invalid_query" }, 400);
    const to = q.data.to ?? "main";
    if (q.data.links === "move" && to !== "main" && to !== "hidden") {
      if (to === g.id) return c.json({ error: "invalid_query" }, 400);
      own(to, user.id);
    }
    tx(db, () => {
      if (q.data.links === "delete") {
        // Booked events stay (booking-links rule 20).
        run(db, "DELETE FROM booking_links WHERE group_id = ?", g.id);
      } else {
        run(
          db,
          "UPDATE booking_links SET group_id = ?, hidden = ? WHERE group_id = ?",
          to === "main" || to === "hidden" ? null : to,
          to === "hidden" ? 1 : 0,
          g.id,
        );
      }
      run(db, "DELETE FROM booking_groups WHERE id = ?", g.id);
    });
    return c.body(null, 204);
  });

  r.get("/share-prefs", (c) => {
    const row = one<{ times_template: string | null; embed_redirect: string }>(
      db,
      "SELECT times_template, embed_redirect FROM booking_share_prefs WHERE user_id = ?",
      c.get("user").id,
    );
    return c.json({
      timesTemplate: row?.times_template ?? null,
      embedRedirect: row?.embed_redirect ?? "disabled",
    });
  });

  r.put("/share-prefs", async (c) => {
    const b = await jsonBody(
      c,
      z.object({
        timesTemplate: z.string().max(4000).optional(),
        embedRedirect: z.enum(["disabled", "topPage", "frame"]).optional(),
      }),
    );
    const id = c.get("user").id;
    run(db, "INSERT OR IGNORE INTO booking_share_prefs (user_id) VALUES (?)", id);
    if (b.timesTemplate !== undefined)
      run(
        db,
        "UPDATE booking_share_prefs SET times_template = ? WHERE user_id = ?",
        b.timesTemplate,
        id,
      );
    if (b.embedRedirect !== undefined)
      run(
        db,
        "UPDATE booking_share_prefs SET embed_redirect = ? WHERE user_id = ?",
        b.embedRedirect,
        id,
      );
    return c.json({ ok: true });
  });

  r.get("/groups", (c) =>
    c.json({
      groups: all<GroupRow>(
        db,
        "SELECT * FROM booking_groups WHERE user_id = ? ORDER BY created_at",
        c.get("user").id,
      ),
    }),
  );
  return r;
}
