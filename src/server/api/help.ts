// Troubleshooting (docs/specs/support-troubleshooting.md): the support contact,
// the event lookup, and the planner's onboarding hints (platform-current-version.md rule 17;
// the first mirroring policy, sync-calendar-mirroring.md rule 11; assistant chat,
// teams-settings-templates.md rule 15).
import { Hono } from "hono";
import type { User } from "../accounts.ts";
import type { AppEnv } from "../app.ts";
import type { Chat } from "../assistant/chat.ts";
import { all, type Db, one, run } from "../db.ts";
import { lookupEvent } from "../diagnosis.ts";
import { notFound } from "../http.ts";
import type { SyncService } from "../sync/service.ts";
import { membership } from "../teams.ts";
import { listedCalendars } from "./calendars.ts";

type Hint = "other-tools" | "first-mirror" | "assistant-chat";

type Offer = "on" | "off" | null;

/**
 * Rule 15: assistant chat is offered to a user who has not chatted yet, when
 * the server has a model and the user can chat, or can turn chat on for the team
 * (an admin while the team switch is off). "off": the team switch is off. A
 * usage limit of 0 refuses every message, so it gets no offer.
 */
function chatOffer(db: Db, chat: Pick<Chat, "refusal">, user: User): Offer {
  if (one(db, "SELECT 1 FROM assistant_conversations WHERE user_id = ?", user.id)) return null;
  const refusal = chat.refusal(user);
  if (!refusal) return "on";
  if (refusal.error === "quota") return refusal.limit > 0 ? "on" : null;
  if (refusal.error === "chat_disabled" && membership(db, user.id).role === "admin") return "off";
  return null;
}

/**
 * Hints the planner shows until the user dismisses them, each while its test
 * holds. `offer` is the chat offer, worked out once per request.
 */
const hints = (db: Db): Record<Hint, (user: User, offer: Offer) => boolean> => ({
  "other-tools": () => true,
  // The first policy is offered while the user has none and two calendars to link.
  "first-mirror": (user) =>
    !one(db, "SELECT 1 FROM mirror_policies WHERE user_id = ?", user.id) &&
    listedCalendars(db, user.id).filter((cal) => cal.provider !== "ics").length > 1,
  "assistant-chat": (_, offer) => offer !== null,
});

export function helpRoutes(
  db: Db,
  supportUrl: string | undefined,
  now: () => number,
  sync: SyncService,
  chat: Pick<Chat, "refusal">,
): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  const shown = hints(db);

  r.get("/help", (c) => c.json({ supportUrl: supportUrl ?? null }));

  const lookup = (userId: string, q: string) => {
    const result = lookupEvent(db, userId, q, now());
    if ("error" in result) return result;
    const { repair, ...shown } = result;
    return { ...shown, repairable: repair.length > 0 };
  };

  r.get("/help/lookup", (c) => {
    const q = (c.req.query("q") ?? "").trim();
    if (!q || q.length > 2000) return c.json({ error: "unreadable" }, 400);
    const result = lookup(c.get("user").id, q);
    return "error" in result ? c.json(result, 404) : c.json(result);
  });

  /** Rule 10: runs the copy decision again for the event and writes the result. */
  r.post("/help/repair", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { q?: unknown };
    const q = typeof body.q === "string" ? body.q.trim() : "";
    if (!q || q.length > 2000) return c.json({ error: "unreadable" }, 400);
    const userId = c.get("user").id;
    const found = lookupEvent(db, userId, q, now());
    if ("error" in found) return c.json(found, 404);
    if (found.repair.length === 0) return c.json({ error: "nothing_to_repair" }, 409);
    const repaired = await sync.repair(userId, found.repair);
    const result = lookup(userId, q);
    if ("error" in result) return c.json(result, 404);
    // The run failed or left the event as it was: the page says so (rule 10).
    return c.json({ ...result, repaired }, repaired ? 200 : 502);
  });

  r.get("/hints", (c) => {
    const dismissed = new Set(
      all<{ hint: string }>(
        db,
        "SELECT hint FROM dismissed_hints WHERE user_id = ?",
        c.get("user").id,
      ).map((h) => h.hint),
    );
    const user = c.get("user");
    const offer = dismissed.has("assistant-chat") ? null : chatOffer(db, chat, user);
    const list = (Object.keys(shown) as Hint[]).filter(
      (h) => !dismissed.has(h) && shown[h](user, offer),
    );
    return c.json({ hints: list, ...(offer ? { chatOff: offer === "off" } : {}) });
  });

  r.post("/hints/:hint/dismiss", (c) => {
    const hint = c.req.param("hint");
    if (!Object.hasOwn(shown, hint)) notFound("hint");
    run(
      db,
      "INSERT OR IGNORE INTO dismissed_hints (user_id, hint, dismissed_at) VALUES (?, ?, ?)",
      c.get("user").id,
      hint,
      now(),
    );
    return c.json({ ok: true });
  });

  return r;
}
