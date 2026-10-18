// Branding of booking pages (docs/specs/booking-links-booking-page.md rules
// 25-31): the team's logo, banner, homepage and default, set by admins.
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AppEnv } from "../app.ts";
import { type Db, one, run } from "../db.ts";
import { jsonBody, notFound } from "../http.ts";
import { membership } from "../teams.ts";

export type Branding = "sameAsGroup" | "default" | "none" | "custom";

interface TeamBrandingRow {
  team_id: string;
  mode: string;
  homepage_url: string;
  logo_type: string | null;
  banner_type: string | null;
  updated_at: number;
}

const LIMITS = { logo: 2 * 1024 * 1024, banner: 8 * 1024 * 1024 } as const;

/** What a booking page shows for a resolved mode, with the team assets for `custom`. */
export function brandingFor(
  db: Db,
  ownerId: string,
  mode: Branding,
): { mode: "default" | "none" | "custom"; logo?: string; banner?: string; homepage?: string } {
  if (mode !== "custom") return { mode: mode === "none" ? "none" : "default" };
  const row = one<TeamBrandingRow>(
    db,
    `SELECT b.team_id, b.mode, b.homepage_url, b.logo_type, b.banner_type, b.updated_at
     FROM team_branding b JOIN team_members m ON m.team_id = b.team_id WHERE m.user_id = ?`,
    ownerId,
  );
  const asset = (kind: "logo" | "banner") =>
    `/pub/branding/${row?.team_id}/${kind}?v=${row?.updated_at}`;
  return {
    mode: "custom",
    ...(row?.logo_type ? { logo: asset("logo") } : {}),
    ...(row?.banner_type ? { banner: asset("banner") } : {}),
    ...(row?.homepage_url ? { homepage: row.homepage_url } : {}),
  };
}

/** The image type from the first bytes: only PNG and JPEG are accepted (edge case 5). */
function imageType(bytes: Uint8Array): string | null {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)
    return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  return null;
}

const refuse = (message: string): never => {
  throw new HTTPException(400, {
    res: Response.json({ error: "invalid_image", message }, { status: 400 }),
  });
};

export function brandingRoutes(db: Db, now: () => number): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  const admin = (userId: string) => {
    const m = membership(db, userId);
    if (m.role !== "admin") {
      throw new HTTPException(403, {
        res: Response.json({ error: "forbidden" }, { status: 403 }),
      });
    }
    return m.team.id;
  };
  const ensure = (teamId: string) =>
    run(
      db,
      "INSERT OR IGNORE INTO team_branding (team_id, updated_at) VALUES (?, ?)",
      teamId,
      now(),
    );

  r.get("/team/branding", (c) => {
    const { team } = membership(db, c.get("user").id);
    const row = one<TeamBrandingRow>(db, "SELECT * FROM team_branding WHERE team_id = ?", team.id);
    return c.json({
      mode: row?.mode ?? "default",
      homepageUrl: row?.homepage_url ?? "",
      logo: row?.logo_type ? `/pub/branding/${team.id}/logo?v=${row.updated_at}` : null,
      banner: row?.banner_type ? `/pub/branding/${team.id}/banner?v=${row.updated_at}` : null,
    });
  });

  r.put("/team/branding", async (c) => {
    const teamId = admin(c.get("user").id);
    const b = await jsonBody(
      c,
      z.object({
        mode: z.enum(["default", "none", "custom"]),
        homepageUrl: z.union([z.literal(""), z.url({ protocol: /^https?$/ })]),
      }),
    );
    ensure(teamId);
    run(
      db,
      "UPDATE team_branding SET mode = ?, homepage_url = ?, updated_at = ? WHERE team_id = ?",
      b.mode,
      b.homepageUrl,
      now(),
      teamId,
    );
    return c.json({ ok: true });
  });

  /** Uploads the logo or the banner: JPG or PNG, 2 MB and 8 MB at most. */
  r.post("/team/branding/:kind", async (c) => {
    const teamId = admin(c.get("user").id);
    const kind = c.req.param("kind");
    if (kind !== "logo" && kind !== "banner") notFound("asset");
    const form = await c.req.parseBody();
    const file = form.file;
    if (!(file instanceof File)) return refuse("Choose a file.");
    if (file.size > LIMITS[kind])
      refuse(`The ${kind} must be ${kind === "logo" ? "2" : "8"} MB or less.`);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const type = imageType(bytes);
    if (!type) refuse("Use a JPG or PNG file.");
    ensure(teamId);
    run(
      db,
      `UPDATE team_branding SET ${kind} = ?, ${kind}_type = ?, updated_at = ? WHERE team_id = ?`,
      bytes,
      type,
      now(),
      teamId,
    );
    return c.json({ ok: true });
  });
  return r;
}

/** The team's images, for public booking pages. */
export function publicBrandingRoutes(db: Db): Hono {
  const r = new Hono();
  r.get("/branding/:team/:kind", (c) => {
    const kind = c.req.param("kind");
    if (kind !== "logo" && kind !== "banner") notFound("asset");
    const row = one<{ data: Uint8Array | null; type: string | null }>(
      db,
      `SELECT ${kind} AS data, ${kind}_type AS type FROM team_branding WHERE team_id = ?`,
      c.req.param("team"),
    );
    if (!row?.data || !row.type) notFound("asset");
    return c.body(new Uint8Array(row.data), 200, {
      "content-type": row.type,
      "cache-control": "public, max-age=31536000, immutable",
    });
  });
  return r;
}
