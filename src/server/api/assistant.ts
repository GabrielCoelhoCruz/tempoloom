// Assistant chat routes (docs/specs/assistant-chat.md): the panel state, one
// message, conversations and the memory list.
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app.ts";
import type { Chat } from "../assistant/chat.ts";
import {
  conversations,
  deleteMemory,
  memories,
  memoryById,
  ownsConversation,
  saveMemory,
} from "../assistant/store.ts";
import type { Db } from "../db.ts";
import { jsonBody, notFound } from "../http.ts";
import { limitRefusal } from "../limits.ts";

const REFUSED = { not_configured: 503, chat_disabled: 403, quota: 429 } as const;

export function assistantRoutes(db: Db, chat: Chat): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  /** The panel: whether chat works, a conversation, the memories and the quota. */
  r.get("/assistant", (c) => {
    const user = c.get("user");
    const list = conversations(db, user.id);
    const asked = c.req.query("conversation");
    const current =
      asked === "new"
        ? null
        : asked && ownsConversation(db, user.id, asked)
          ? asked
          : (list[0]?.id ?? null);
    return c.json({
      refusal: chat.refusal(user),
      conversations: list,
      conversationId: current,
      items: current ? chat.items(user.id, current) : [],
      memories: memories(db, user.id),
      quota: chat.quota(user),
      // The panel waits this long for a running message (a resend after a lost answer).
      waitMs: chat.waitMs,
    });
  });

  r.post("/assistant/messages", async (c) => {
    const body = await jsonBody(
      c,
      z.object({
        conversationId: z.string().nullable().optional(),
        text: z.string().trim().min(1).max(4000),
        clientId: z.string().min(8).max(100).optional(),
        context: z
          .object({
            from: z.string().max(10).optional(),
            to: z.string().max(10).optional(),
            eventId: z.string().max(500).optional(),
          })
          .optional(),
      }),
    );
    // The request's signal stops the turn when the client leaves.
    const r = await chat.send(c.get("user"), body, c.req.raw.signal);
    switch (r.kind) {
      case "ok":
        return c.json({ conversationId: r.conversationId, items: r.items });
      case "refused":
        return c.json(r.refusal, REFUSED[r.refusal.error]);
      case "in_progress":
        return c.json(
          { error: "in_progress", message: "This message is still being answered. Wait a moment." },
          409,
        );
      case "mismatch":
        return c.json(
          {
            error: "client_id_reused",
            message: "This message id was used for another message. Send it again.",
          },
          422,
        );
      case "failed":
        return c.json(
          {
            error: "llm_failed",
            message: r.message,
            ...(r.conversationId ? { conversationId: r.conversationId, items: r.items } : {}),
          },
          502,
        );
    }
  });

  /** The user approves a memory the assistant proposed (rule 22). */
  r.post("/assistant/memories/:id/save", (c) => {
    const refused = chat.refusal(c.get("user"));
    if (refused && refused.error !== "quota") return c.json(refused, REFUSED[refused.error]);
    const user = c.get("user");
    if (memoryById(db, user.id, c.req.param("id"))?.state !== "pending") notFound("memory");
    // Plans rule 4: a proposed memory that would pass the limit stays proposed.
    const limit = limitRefusal(db, "max_chat_memories", memories(db, user.id).length);
    if (limit) return c.json(limit, 409);
    if (!saveMemory(db, user.id, c.req.param("id"))) notFound("memory");
    return c.json({ ok: true });
  });

  r.get("/assistant/memories", (c) => c.json({ memories: memories(db, c.get("user").id) }));

  r.delete("/assistant/memories/:id", (c) => {
    if (!deleteMemory(db, c.get("user").id, c.req.param("id"))) notFound("memory");
    return c.json({ ok: true });
  });

  return r;
}
