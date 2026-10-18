// Booking links: the owner's settings (under /api) and the public pages'
// API (under /pub, no session). Specs: booking-links*.md.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { type CalendarItem, type LinkRules, offeredTimes } from "../../scheduler/availability.ts";
import type { WeeklyHours } from "../../scheduler/hours.ts";
import type { ExternalEvent, Level } from "../../scheduler/model.ts";
import type { AppEnv } from "../app.ts";
import { all, type Db, one, run, tx } from "../db.ts";
import { jsonBody, notFound } from "../http.ts";
import { MANAGED_PROP } from "../planner/push.ts";
import { writeCalendar } from "../planner/replan.ts";
import { getSettings } from "../settings.ts";
import { cacheEvent } from "../sync/pull.ts";
import type { SyncService } from "../sync/service.ts";

export interface LinkRow {
  id: string;
  user_id: string;
  slug: string;
  hidden: number;
  title: string;
  description: string;
  title_template: string;
  durations: string;
  level: Level;
  hours_set_id: string | null;
  notice_minutes: number;
  range_end_days: number;
  buffer_before: number;
  buffer_after: number;
  max_per_day: number | null;
  max_per_week: number | null;
  location: string;
}

interface BookingRow {
  id: string;
  link_id: string | null;
  user_id: string;
  calendar_id: string | null;
  event_id: string | null;
  start_ms: number;
  end_ms: number;
  name: string;
  email: string;
  message: string;
  status: "booked" | "cancelled";
}

const slugRe = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const hash = (t: string) => createHash("sha256").update(t).digest("base64url");
const MAX_SPAN = 15 * 86_400_000;

export function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "link"
  );
}

const linkInput = z.object({
  title: z.string().trim().min(1).max(120),
  description: z.string().max(4000).optional(),
  slug: z.string().regex(slugRe).optional(),
  hidden: z.boolean().optional(),
  durations: z.array(z.number().int().min(5).max(480).multipleOf(5)).min(1).max(3),
  level: z.number().int().min(1).max(4).optional(),
  hoursSetId: z.string().nullable().optional(),
  noticeMinutes: z
    .number()
    .int()
    .min(0)
    .max(30 * 24 * 60)
    .optional(),
  rangeEndDays: z.number().int().min(0).max(100).optional(),
  bufferBefore: z.number().int().min(0).max(120).optional(),
  bufferAfter: z.number().int().min(0).max(120).optional(),
  maxPerDay: z.number().int().min(1).max(50).nullable().optional(),
  maxPerWeek: z.number().int().min(1).max(200).nullable().optional(),
  location: z.string().max(500).optional(),
});

/** Classifies the owner's events for availability (class table of the spec). */
export function calendarItems(db: Db, userId: string, from: number, to: number): CalendarItem[] {
  const items: CalendarItem[] = [];
  for (const e of all<{
    summary: string;
    description: string;
    start_ms: number;
    end_ms: number;
    busy: number;
    event_type: string;
    self_response: ExternalEvent["selfResponse"];
    organizer_self: number;
    private_props: string;
  }>(
    db,
    `SELECT e.* FROM events e JOIN calendars c ON c.id = e.calendar_id JOIN accounts a ON a.id = c.account_id
     WHERE a.user_id = ? AND a.status = 'ok' AND c.check_availability = 1 AND e.end_ms > ? AND e.start_ms < ?`,
    userId,
    from,
    to,
  )) {
    const props = JSON.parse(e.private_props) as Record<string, string>;
    if (props[MANAGED_PROP] === "1") continue;
    const span = { start: e.start_ms, end: e.end_ms };
    if (props.tl_booking === "1") {
      items.push({
        ...span,
        cls: "booked",
        ...(props.tl_booking_id ? { bookingId: props.tl_booking_id } : {}),
      });
    } else if (!e.busy || e.self_response === "declined") {
      // Free events (with or without #tl_busy) and declined invitations never block a link.
      items.push({ ...span, cls: "free" });
    } else {
      // Other busy events block, including unanswered invitations: a booking is final.
      items.push({ ...span, cls: "fixed" });
    }
  }
  const levels = new Map<string, Level>();
  for (const t of all<{ id: string; level: Level }>(
    db,
    "SELECT id, level FROM tasks WHERE user_id = ?",
    userId,
  )) {
    levels.set(`task:${t.id}`, t.level);
  }
  for (const h of all<{ id: string; level: Level }>(
    db,
    "SELECT id, level FROM habits WHERE user_id = ?",
    userId,
  )) {
    levels.set(`habit:${h.id}`, h.level);
  }
  for (const b of all<{ id: string; level: Level }>(
    db,
    "SELECT id, level FROM buffers WHERE user_id = ?",
    userId,
  )) {
    levels.set(`buffer:${b.id}`, b.level);
  }
  for (const m of all<{
    kind: string;
    source_id: string;
    start_ms: number;
    end_ms: number;
    busy: number;
    locked: number;
  }>(
    db,
    "SELECT kind, source_id, start_ms, end_ms, busy, locked FROM managed_events WHERE user_id = ? AND end_ms > ? AND start_ms < ?",
    userId,
    from,
    to,
  )) {
    const span = { start: m.start_ms, end: m.end_ms };
    if (m.locked) items.push({ ...span, cls: "fixed" });
    else if (!m.busy) items.push({ ...span, cls: "free" });
    else {
      // Placed focus time counts as P2 for booking links.
      const level = m.kind === "focus" ? 2 : (levels.get(`${m.kind}:${m.source_id}`) ?? 1);
      items.push({ ...span, cls: "prioritized", level });
    }
  }
  return items;
}

function rulesFor(db: Db, link: LinkRow, duration: number): LinkRules {
  const user = one<{ time_zone: string }>(
    db,
    "SELECT time_zone FROM users WHERE id = ?",
    link.user_id,
  );
  const hoursId =
    link.hours_set_id ??
    one<{ id: string }>(
      db,
      "SELECT id FROM hours_sets WHERE user_id = ? AND kind = 'meeting' ORDER BY created_at LIMIT 1",
      link.user_id,
    )?.id;
  const weekly = JSON.parse(
    (hoursId &&
      one<{ weekly: string }>(db, "SELECT weekly FROM hours_sets WHERE id = ?", hoursId)?.weekly) ||
      "{}",
  ) as WeeklyHours;
  return {
    durationMinutes: duration,
    level: link.level,
    hours: weekly,
    zone: user?.time_zone ?? "UTC",
    weekStart: getSettings(db, link.user_id).weekStart,
    noticeMinutes: link.notice_minutes,
    rangeEndDays: link.range_end_days,
    bufferBeforeMinutes: link.buffer_before,
    bufferAfterMinutes: link.buffer_after,
    maxPerDay: link.max_per_day,
    maxPerWeek: link.max_per_week,
  };
}

export function linkTimes(
  db: Db,
  link: LinkRow,
  duration: number,
  from: number,
  to: number,
  now: number,
  rescheduling?: string,
) {
  const bookings = all<{ id: string; start_ms: number; end_ms: number }>(
    db,
    "SELECT id, start_ms, end_ms FROM bookings WHERE link_id = ? AND status = 'booked' AND end_ms > ?",
    link.id,
    now - 8 * 86_400_000,
  ).map((b) => ({ id: b.id, start: b.start_ms, end: b.end_ms }));
  const pad = (link.buffer_before + link.buffer_after + duration) * 60_000;
  return offeredTimes(
    rulesFor(db, link, duration),
    calendarItems(db, link.user_id, from - pad, to + pad),
    bookings,
    now,
    from,
    to,
    rescheduling,
  );
}

function publicLink(link: LinkRow) {
  return {
    slug: link.slug,
    title: link.title,
    description: link.description,
    durations: JSON.parse(link.durations) as number[],
    location: link.location,
  };
}

function eventTitle(link: LinkRow, organizer: string, attendee: string): string {
  return link.title_template
    .replaceAll("{organizer}", organizer)
    .replaceAll("{attendee}", attendee)
    .replaceAll("{title}", link.title);
}

export function bookingRoutes(db: Db, now: () => number): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.get("/page", (c) => {
    const page = one<{ slug: string }>(
      db,
      "SELECT slug FROM booking_pages WHERE user_id = ?",
      c.get("user").id,
    );
    return c.json({ slug: page?.slug ?? null });
  });

  /** Claims the user's booking page slug and creates the starter links (booking-links rules 1, 2). */
  r.post("/page", async (c) => {
    const user = c.get("user");
    const { slug } = await jsonBody(c, z.object({ slug: z.string().regex(slugRe) }));
    const taken = one<{ user_id: string }>(
      db,
      "SELECT user_id FROM booking_pages WHERE slug = ?",
      slug,
    );
    if (taken && taken.user_id !== user.id) return c.json({ error: "slug_taken" }, 409);
    tx(db, () => {
      const had = one(db, "SELECT 1 FROM booking_pages WHERE user_id = ?", user.id);
      run(
        db,
        `INSERT INTO booking_pages (user_id, slug, created_at) VALUES (?, ?, ?)
         ON CONFLICT (user_id) DO UPDATE SET slug = excluded.slug`,
        user.id,
        slug,
        now(),
      );
      if (!had) {
        for (const [title, level, durations] of [
          ["Important meeting", 1, [30]],
          ["Quick meeting", 3, [15, 30]],
          ["Meeting", 2, [30, 60]],
        ] as const) {
          insertLink(user.id, { title, level, durations: [...durations] });
        }
      }
    });
    return c.json({ slug });
  });

  function insertLink(userId: string, b: z.infer<typeof linkInput>): string {
    let slug = b.slug ?? slugify(b.title);
    for (
      let i = 2;
      one(db, "SELECT 1 FROM booking_links WHERE user_id = ? AND slug = ?", userId, slug);
      i++
    ) {
      slug = `${b.slug ?? slugify(b.title)}-${i}`;
    }
    const id = randomUUID();
    run(
      db,
      `INSERT INTO booking_links (id, user_id, slug, hidden, title, description, title_template, durations, level,
         hours_set_id, notice_minutes, range_end_days, buffer_before, buffer_after, max_per_day, max_per_week, location, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      userId,
      slug,
      b.hidden ? 1 : 0,
      b.title,
      b.description ?? "",
      "{title} with {attendee}",
      JSON.stringify(b.durations),
      b.level ?? 2,
      b.hoursSetId ?? null,
      b.noticeMinutes ?? 240,
      b.rangeEndDays ?? 30,
      b.bufferBefore ?? 0,
      b.bufferAfter ?? 0,
      b.maxPerDay ?? null,
      b.maxPerWeek ?? null,
      b.location ?? "",
      now(),
    );
    return id;
  }

  r.get("/links", (c) => {
    const user = c.get("user");
    const links = all<LinkRow>(
      db,
      "SELECT * FROM booking_links WHERE user_id = ? ORDER BY level, created_at",
      user.id,
    );
    return c.json({
      links: links.map((l) => ({ ...l, durations: JSON.parse(l.durations) as number[] })),
    });
  });

  r.post("/links", async (c) => {
    const user = c.get("user");
    if (!one(db, "SELECT 1 FROM booking_pages WHERE user_id = ?", user.id))
      return c.json({ error: "no_page" }, 400);
    const body = await jsonBody(c, linkInput);
    if (
      body.slug &&
      one(db, "SELECT 1 FROM booking_links WHERE user_id = ? AND slug = ?", user.id, body.slug)
    ) {
      return c.json({ error: "slug_taken" }, 409);
    }
    const id = insertLink(user.id, body);
    return c.json({ link: one(db, "SELECT * FROM booking_links WHERE id = ?", id) }, 201);
  });

  r.delete("/links/:id", (c) => {
    // Booked events stay (booking-links rule 20).
    run(
      db,
      "DELETE FROM booking_links WHERE id = ? AND user_id = ?",
      c.req.param("id"),
      c.get("user").id,
    );
    return c.body(null, 204);
  });

  r.get("/bookings", (c) =>
    c.json({
      bookings: all(
        db,
        `SELECT b.id, b.start_ms, b.end_ms, b.name, b.email, b.status, l.title AS link_title FROM bookings b
         LEFT JOIN booking_links l ON l.id = b.link_id WHERE b.user_id = ? ORDER BY b.start_ms DESC LIMIT 200`,
        c.get("user").id,
      ),
    }),
  );
  return r;
}

/** Public booking API: no session; the page and link slugs or a manage token identify the data. */
export function publicBookingRoutes(
  db: Db,
  sync: SyncService,
  baseUrl: string,
  now: () => number,
): Hono {
  const r = new Hono();
  const findLink = (page: string, link: string) =>
    one<LinkRow>(
      db,
      `SELECT l.* FROM booking_links l JOIN booking_pages p ON p.user_id = l.user_id WHERE p.slug = ? AND l.slug = ?`,
      page,
      link,
    );

  r.get("/pages/:page", (c) => {
    const page = one<{ user_id: string; slug: string }>(
      db,
      "SELECT user_id, slug FROM booking_pages WHERE slug = ?",
      c.req.param("page"),
    );
    if (!page) notFound("page");
    const owner = one<{ name: string }>(db, "SELECT name FROM users WHERE id = ?", page.user_id);
    const links = all<LinkRow>(
      db,
      "SELECT * FROM booking_links WHERE user_id = ? AND hidden = 0 ORDER BY level, created_at",
      page.user_id,
    );
    return c.json({ name: owner?.name ?? "", slug: page.slug, links: links.map(publicLink) });
  });

  r.get("/pages/:page/:link", (c) => {
    const link = findLink(c.req.param("page"), c.req.param("link"));
    if (!link) notFound("link");
    const owner = one<{ name: string; time_zone: string }>(
      db,
      "SELECT name, time_zone FROM users WHERE id = ?",
      link.user_id,
    );
    return c.json({
      link: publicLink(link),
      organizer: owner?.name ?? "",
      timeZone: owner?.time_zone ?? "UTC",
    });
  });

  r.get("/pages/:page/:link/times", (c) => {
    const link = findLink(c.req.param("page"), c.req.param("link"));
    if (!link) notFound("link");
    const q = z
      .object({
        duration: z.coerce.number().int(),
        from: z.coerce.number().int(),
        to: z.coerce.number().int(),
        token: z.string().optional(),
      })
      .safeParse(c.req.query());
    const durations = JSON.parse(link.durations) as number[];
    if (
      !q.success ||
      !durations.includes(q.data.duration) ||
      q.data.to <= q.data.from ||
      q.data.to - q.data.from > MAX_SPAN
    ) {
      return c.json({ error: "invalid_query" }, 400);
    }
    const resched = q.data.token
      ? one<{ id: string }>(
          db,
          "SELECT id FROM bookings WHERE token_hash = ? AND link_id = ?",
          hash(q.data.token),
          link.id,
        )?.id
      : undefined;
    return c.json({
      times: linkTimes(db, link, q.data.duration, q.data.from, q.data.to, now(), resched),
    });
  });

  const bookInput = z.object({
    start: z.number().int(),
    duration: z.number().int(),
    name: z.string().trim().min(1).max(200),
    email: z.email(),
    message: z.string().max(4000).optional(),
  });

  const offered = (link: LinkRow, start: number, duration: number, resched?: string) =>
    linkTimes(db, link, duration, start, start + duration * 60_000, now(), resched).some(
      (t) => t.start === start,
    );

  function manageText(token: string): string {
    const url = new URL(`/book/manage/${token}`, baseUrl).toString();
    return `Reschedule or cancel: ${url}`;
  }

  r.post("/pages/:page/:link/book", async (c) => {
    const link = findLink(c.req.param("page"), c.req.param("link"));
    if (!link) notFound("link");
    const body = await jsonBody(c, bookInput);
    if (!(JSON.parse(link.durations) as number[]).includes(body.duration))
      return c.json({ error: "invalid_duration" }, 400);
    const result = await sync.exclusive(link.user_id, async (pool) => {
      // Check again inside the owner's queue so two bookers cannot take one slot.
      if (!offered(link, body.start, body.duration)) return { error: "slot_taken" as const };
      const target = writeCalendar(db, link.user_id);
      if (!target) return { error: "no_calendar" as const };
      const organizer =
        one<{ name: string }>(db, "SELECT name FROM users WHERE id = ?", link.user_id)?.name ?? "";
      const id = randomUUID();
      const token = randomBytes(24).toString("base64url");
      const end = body.start + body.duration * 60_000;
      const description = [body.message ?? "", manageText(token)].filter(Boolean).join("\n\n");
      const ev = await pool.get(target.account_id).insertEvent(target.provider_id, {
        summary: eventTitle(link, organizer, body.name),
        description,
        start: body.start,
        end,
        busy: true,
        colorId: null,
        attendees: [body.email],
        ...(link.location ? { location: link.location } : {}),
        privateProps: { tl_booking: "1", tl_booking_id: id },
      });
      cacheEvent(db, target.id, ev);
      run(
        db,
        `INSERT INTO bookings (id, link_id, user_id, calendar_id, event_id, start_ms, end_ms, name, email, message,
           token_hash, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'booked', ?, ?)`,
        id,
        link.id,
        link.user_id,
        target.id,
        ev.id,
        body.start,
        end,
        body.name,
        body.email,
        body.message ?? "",
        hash(token),
        now(),
        now(),
      );
      return { token, start: body.start, end };
    });
    if ("error" in result) return c.json(result, result.error === "slot_taken" ? 409 : 500);
    return c.json(result, 201);
  });

  const byToken = (token: string) =>
    one<BookingRow>(db, "SELECT * FROM bookings WHERE token_hash = ?", hash(token));

  r.get("/bookings/:token", (c) => {
    const b = byToken(c.req.param("token"));
    if (!b) notFound("booking");
    const link = b.link_id
      ? one<LinkRow>(db, "SELECT * FROM booking_links WHERE id = ?", b.link_id)
      : undefined;
    const page = one<{ slug: string }>(
      db,
      "SELECT slug FROM booking_pages WHERE user_id = ?",
      b.user_id,
    );
    return c.json({
      booking: { start: b.start_ms, end: b.end_ms, name: b.name, status: b.status },
      link: link ? publicLink(link) : null,
      page: page?.slug ?? null,
    });
  });

  r.post("/bookings/:token/reschedule", async (c) => {
    const token = c.req.param("token");
    const b = byToken(token);
    if (!b || b.status !== "booked" || !b.link_id) notFound("booking");
    const link = one<LinkRow>(db, "SELECT * FROM booking_links WHERE id = ?", b.link_id);
    if (!link) notFound("link");
    const { start } = await jsonBody(c, z.object({ start: z.number().int() }));
    const duration = (b.end_ms - b.start_ms) / 60_000;
    const result = await sync.exclusive(b.user_id, async (pool) => {
      if (!offered(link, start, duration, b.id)) return { error: "slot_taken" as const };
      const cal = one<{ account_id: string; provider_id: string }>(
        db,
        "SELECT account_id, provider_id FROM calendars WHERE id = ?",
        b.calendar_id ?? "",
      );
      if (!cal || !b.event_id) return { error: "no_event" as const };
      const organizer =
        one<{ name: string }>(db, "SELECT name FROM users WHERE id = ?", b.user_id)?.name ?? "";
      const ev = await pool.get(cal.account_id).updateEvent(
        cal.provider_id,
        b.event_id,
        {
          summary: eventTitle(link, organizer, b.name),
          description: [b.message, manageText(token)].filter(Boolean).join("\n\n"),
          start,
          end: start + duration * 60_000,
          busy: true,
          colorId: null,
          attendees: [b.email],
          ...(link.location ? { location: link.location } : {}),
          privateProps: { tl_booking: "1", tl_booking_id: b.id },
        },
        null,
      );
      if (b.calendar_id) cacheEvent(db, b.calendar_id, ev);
      run(
        db,
        "UPDATE bookings SET start_ms = ?, end_ms = ?, updated_at = ? WHERE id = ?",
        start,
        start + duration * 60_000,
        now(),
        b.id,
      );
      return { start, end: start + duration * 60_000 };
    });
    if ("error" in result) return c.json(result, result.error === "slot_taken" ? 409 : 500);
    return c.json(result);
  });

  r.post("/bookings/:token/cancel", async (c) => {
    const b = byToken(c.req.param("token"));
    if (!b || b.status !== "booked") notFound("booking");
    await sync.exclusive(b.user_id, async (pool) => {
      const cal = one<{ account_id: string; provider_id: string }>(
        db,
        "SELECT account_id, provider_id FROM calendars WHERE id = ?",
        b.calendar_id ?? "",
      );
      if (cal && b.event_id) {
        await pool.get(cal.account_id).deleteEvent(cal.provider_id, b.event_id);
        run(
          db,
          "DELETE FROM events WHERE calendar_id = ? AND event_id = ?",
          b.calendar_id ?? "",
          b.event_id,
        );
      }
      run(db, "UPDATE bookings SET status = 'cancelled', updated_at = ? WHERE id = ?", now(), b.id);
    });
    return c.json({ ok: true });
  });

  return r;
}
