// Assistant chat routes (docs/specs/assistant-chat.md): the panel state, one
// message, conversations and the memory list.
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app.ts";
import { type Chat, LlmError } from "../assistant/chat.ts";
import { conversations, deleteMemory, memories, ownsConversation } from "../assistant/store.ts";
import type { Db } from "../db.ts";
import { jsonBody, notFound } from "../http.ts";

const STATUS = { not_configured: 503, chat_disabled: 403, quota: 429 } as const;

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
    const user = c.get("user");
    const body = await jsonBody(
      c,
      z.object({
        conversationId: z.string().nullable().optional(),
        text: z.string().trim().min(1).max(4000),
        context: z
          .object({
            from: z.string().max(10).optional(),
            to: z.string().max(10).optional(),
            eventId: z.string().max(500).optional(),
          })
          .optional(),
      }),
    );
    const refused = chat.refusal(user);
    if (refused) return c.json(refused, STATUS[refused.error]);
    try {
      const { conversationId } = await chat.send(
        user,
        body.conversationId ?? null,
        body.text,
        body.context ?? {},
      );
      return c.json({ conversationId, items: chat.items(user.id, conversationId) });
    } catch (err) {
      if (!(err instanceof LlmError)) throw err;
      // The text names no URL and no key (src/server/llm.ts).
      console.error(`Assistant chat: ${err.message}`);
      return c.json({ error: "llm_failed", message: err.message }, 502);
    }
  });

  r.get("/assistant/memories", (c) => c.json({ memories: memories(db, c.get("user").id) }));

  r.delete("/assistant/memories/:id", (c) => {
    if (!deleteMemory(db, c.get("user").id, c.req.param("id"))) notFound("memory");
    return c.json({ ok: true });
  });

  return r;
}
