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
  ownsConversation,
  saveMemory,
} from "../assistant/store.ts";
import type { Db } from "../db.ts";
import { jsonBody, notFound } from "../http.ts";

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
    return c.json(r.body, r.status as 200);
  });

  /** The user approves a memory the assistant proposed (rule 22). */
  r.post("/assistant/memories/:id/save", (c) => {
    if (!saveMemory(db, c.get("user").id, c.req.param("id"))) notFound("memory");
    return c.json({ ok: true });
  });

  r.get("/assistant/memories", (c) => c.json({ memories: memories(db, c.get("user").id) }));

  r.delete("/assistant/memories/:id", (c) => {
    if (!deleteMemory(db, c.get("user").id, c.req.param("id"))) notFound("memory");
    return c.json({ ok: true });
  });

  return r;
}
