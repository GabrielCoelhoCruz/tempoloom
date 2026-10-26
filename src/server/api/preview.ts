// Preview mode routes (docs/specs/assistant-preview-mode.md): the switch, the
// staged changes with their calendar impact, accept or discard, and apply.
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app.ts";
import type { Db } from "../db.ts";
import { jsonBody, notFound } from "../http.ts";
import {
  decide,
  impactWords,
  newDescription,
  openChanges,
  type Preview,
  previewMode,
  type Source,
  setPreviewMode,
} from "../preview.ts";

const SOURCES: Record<Source, string> = {
  assistant_chat: "Assistant chat",
  mcp_client: "AI tool",
  automation_edit: "Automation edit",
  manual: "Your edit",
};

export function previewRoutes(
  db: Db,
  preview: Preview,
  info: { baseUrl: string; mcpWriteEnabled: boolean },
  now: () => number,
): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.get("/preview", (c) => {
    const user = c.get("user");
    const mode = previewMode(db, user.id);
    const changes = openChanges(db, user.id, now());
    return c.json({
      on: mode.on,
      byHand: mode.byHand,
      changes: changes.map((ch) => ({
        id: ch.id,
        source: ch.source,
        sourceLabel:
          ch.source === "mcp_client" && ch.client
            ? `${SOURCES[ch.source]} (${ch.client})`
            : SOURCES[ch.source],
        summary: ch.summary,
        description: newDescription(ch),
        reason: ch.reason,
        state: ch.state,
        impact: impactWords(ch.impact),
        createdAt: ch.createdAt,
      })),
      overlay: changes.flatMap((ch) => ch.impact.map((i) => ({ changeId: ch.id, ...i }))),
    });
  });

  /** Rule 3: the user turns preview mode on or off; pending changes stay either way (rule 10). */
  r.post("/preview/mode", async (c) => {
    const { on } = await jsonBody(c, z.object({ on: z.boolean() }));
    setPreviewMode(db, c.get("user").id, on, true, now());
    return c.json({ ok: true });
  });

  r.post("/preview/:id/:decision{accept|discard}", (c) => {
    const state = c.req.param("decision") === "accept" ? "accepted" : "discarded";
    if (!decide(db, c.get("user").id, c.req.param("id"), state, now())) notFound("staged change");
    return c.json({ ok: true });
  });

  /** Rules 7-8: the user confirms the final list. */
  r.post("/preview/apply", async (c) => {
    const { ids } = await jsonBody(c, z.object({ ids: z.array(z.string()).max(500) }));
    return c.json(await preview.apply(c.get("user").id, ids));
  });

  /** What the account page says about the MCP server (assistant-mcp-server.md). */
  r.get("/mcp/info", (c) =>
    c.json({ url: new URL("/mcp", info.baseUrl).toString(), writeEnabled: info.mcpWriteEnabled }),
  );

  return r;
}
