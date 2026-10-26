// Assistant chat (docs/specs/assistant-chat.md): one turn runs the model with
// the chat tools until it answers in text. Tool calls run through the same
// callTool as the MCP server; write tools only stage changes in preview mode
// (rule 12). A finished turn is saved, so a reload shows the conversation and
// the next turn has its context (rule 11). A failed turn saves nothing, and the
// panel keeps the draft (edge case 5).
import { addDays, localToUtc, utcToLocal } from "../../shared/time.ts";
import type { User } from "../accounts.ts";
import { all, type Db, one } from "../db.ts";
import { instanceLimit, limitMessage } from "../limits.ts";
import { type Llm, LlmError, type LlmMessage } from "../llm.ts";
import { type Caller, callTool, type Tool } from "../mcp/rpc.ts";
import { userFormatsOf, whenAt, zoneOf } from "../preview.ts";
import { membership } from "../teams.ts";
import { type PromptInput, systemPrompt } from "./prompt.ts";
import { countUse, memories, messagesOf, ownsConversation, saveTurn, usedOn } from "./store.ts";
import { llmTool } from "./tools.ts";

/** Model calls in one turn, at most: a turn that needs more stops with a note. */
export const MAX_STEPS = 8;
/** Stored messages sent as context, at most; older ones are cut at a user message. */
export const MAX_HISTORY = 60;

export type ChatRefusal =
  | { error: "not_configured"; message: string }
  | { error: "chat_disabled"; message: string; admins: { name: string; email: string }[] }
  | { error: "quota"; message: string; limit: number; resetsAt: number };

export interface ChatContext {
  from?: string | undefined;
  to?: string | undefined;
  eventId?: string | undefined;
}

/** One item the panel draws. */
export type ChatItem =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "proposal"; changeId: string; summary: string; state: string }
  | { kind: "memory"; text: string };

export interface ChatDeps {
  db: Db;
  llm: Llm | null;
  tools: Tool[];
  now: () => number;
}

export function createChat(deps: ChatDeps) {
  const { db, llm, tools, now } = deps;
  const byName = new Map(tools.map((t) => [t.name, t]));
  const llmTools = tools.map(llmTool);

  /** The local day of the user and the instant the next one starts. */
  function today(userId: string) {
    const zone = zoneOf(db, userId);
    const day = utcToLocal(zone, now()).date;
    return { zone, day, next: localToUtc(zone, addDays(day, 1), 0) };
  }

  /** Why the user cannot chat now, or null (rules 2, 27). */
  function refusal(user: User): ChatRefusal | null {
    if (!llm)
      return {
        error: "not_configured",
        message:
          "The assistant is not configured on this server. Ask the server operator to set it up.",
      };
    const { team } = membership(db, user.id);
    if (team.assistant_chat_enabled !== 1)
      return {
        error: "chat_disabled",
        message: "Assistant chat is off for your team. Ask a team admin to turn it on.",
        admins: all<{ name: string; email: string }>(
          db,
          `SELECT u.name, u.email FROM team_members m JOIN users u ON u.id = m.user_id
           WHERE m.team_id = ? AND m.role = 'admin' ORDER BY u.name, u.email`,
          team.id,
        ),
      };
    const limit = instanceLimit(db, "assistant_chat_quota");
    if (limit !== null) {
      const t = today(user.id);
      if (usedOn(db, user.id, t.day) >= limit)
        return {
          error: "quota",
          limit,
          resetsAt: t.next,
          message: `${limitMessage("assistant_chat_quota", limit)} You reached it today. It resets at ${whenAt(t.zone, t.next, userFormatsOf(db, user.id))}.`,
        };
    }
    return null;
  }

  function quota(user: User) {
    const limit = instanceLimit(db, "assistant_chat_quota");
    if (limit === null) return null;
    const t = today(user.id);
    return { limit, used: usedOn(db, user.id, t.day), resetsAt: t.next };
  }

  function promptInput(user: User, ctx: ChatContext): PromptInput {
    const zone = zoneOf(db, user.id);
    const date = /^\d{4}-\d{2}-\d{2}$/;
    const shown =
      ctx.from && ctx.to && date.test(ctx.from) && date.test(ctx.to)
        ? { from: ctx.from, to: ctx.to }
        : undefined;
    const selected = ctx.eventId ? selectedEvent(user.id, ctx.eventId) : undefined;
    return {
      name: user.name,
      email: user.email,
      zone,
      now: now(),
      shown,
      selected,
      memories: memories(db, user.id),
    };
  }

  function selectedEvent(userId: string, id: string) {
    if (id.startsWith("ext:")) {
      const rest = id.slice(4);
      const cut = rest.indexOf(":");
      const e = one<{ summary: string; start_ms: number; end_ms: number }>(
        db,
        `SELECT e.summary, e.start_ms, e.end_ms FROM events e JOIN calendars c ON c.id = e.calendar_id
         JOIN accounts a ON a.id = c.account_id WHERE a.user_id = ? AND e.calendar_id = ? AND e.event_id = ?`,
        userId,
        rest.slice(0, cut),
        rest.slice(cut + 1),
      );
      return e && { id, title: e.summary, start: e.start_ms, end: e.end_ms };
    }
    const m = one<{ title: string; start_ms: number; end_ms: number }>(
      db,
      "SELECT title, start_ms, end_ms FROM managed_events WHERE id = ? AND user_id = ?",
      id,
      userId,
    );
    return m && { id, title: m.title, start: m.start_ms, end: m.end_ms };
  }

  /** The stored context: the last MAX_HISTORY messages, starting at a user message. */
  function history(conversationId: string | null): LlmMessage[] {
    if (!conversationId) return [];
    const all = messagesOf(db, conversationId);
    if (all.length <= MAX_HISTORY) return all;
    let start = all.length - MAX_HISTORY;
    while (start < all.length && all[start]?.role !== "user") start++;
    return all.slice(start);
  }

  async function runTool(caller: Caller, name: string, raw: string): Promise<string> {
    const t = byName.get(name);
    if (!t) return `Error: there is no tool ${name}.`;
    let args: unknown;
    try {
      args = raw.trim() ? JSON.parse(raw) : {};
    } catch {
      return "Error: the arguments are not valid JSON.";
    }
    const r = await callTool(t, caller, args);
    return r.isError ? `Error: ${r.text}` : r.text;
  }

  /**
   * Runs one turn. Throws LlmError when the model fails; then nothing of the
   * turn is saved (changes staged before the failure stay in preview mode).
   */
  async function send(
    user: User,
    conversationId: string | null,
    text: string,
    ctx: ChatContext,
  ): Promise<{ conversationId: string }> {
    if (!llm) throw new Error("not configured");
    if (conversationId && !ownsConversation(db, user.id, conversationId)) conversationId = null;
    const caller: Caller = { user, client: "", source: "assistant_chat" };
    const turn: LlmMessage[] = [{ role: "user", content: text }];
    const base: LlmMessage[] = [
      { role: "system", content: systemPrompt(promptInput(user, ctx)) },
      ...history(conversationId),
    ];
    let answered = false;
    for (let step = 0; step < MAX_STEPS; step++) {
      const reply = await llm.complete([...base, ...turn], llmTools);
      turn.push(reply);
      if (!reply.tool_calls?.length) {
        answered = true;
        break;
      }
      for (const call of reply.tool_calls)
        turn.push({
          role: "tool",
          tool_call_id: call.id,
          content: await runTool(caller, call.function.name, call.function.arguments),
        });
    }
    if (!answered)
      turn.push({
        role: "assistant",
        content: "I stopped: this request needed too many steps. Please ask in smaller parts.",
      });
    const id = saveTurn(db, user.id, conversationId, turn, now());
    countUse(db, user.id, today(user.id).day);
    return { conversationId: id };
  }

  /** The items the panel shows for a conversation, with each proposal's current state. */
  function items(userId: string, conversationId: string): ChatItem[] {
    const out: ChatItem[] = [];
    const calls = new Map<string, string>();
    for (const m of messagesOf(db, conversationId)) {
      if (m.role === "user") out.push({ kind: "user", text: m.content });
      else if (m.role === "assistant") {
        for (const c of m.tool_calls ?? []) calls.set(c.id, c.function.name);
        if (m.content?.trim()) out.push({ kind: "assistant", text: m.content });
      } else if (m.role === "tool") {
        const t = byName.get(calls.get(m.tool_call_id) ?? "");
        if (!t || (t.effect !== "stage" && t.effect !== "store") || m.content.startsWith("Error:"))
          continue;
        let data: { id?: unknown; summary?: unknown; text?: unknown };
        try {
          data = JSON.parse(m.content);
        } catch {
          continue;
        }
        if (t.effect === "store" && typeof data.text === "string")
          out.push({ kind: "memory", text: data.text });
        if (t.effect === "stage" && typeof data.id === "string") {
          const state =
            one<{ state: string }>(
              db,
              "SELECT state FROM staged_changes WHERE id = ? AND user_id = ?",
              data.id,
              userId,
            )?.state ?? "expired";
          out.push({
            kind: "proposal",
            changeId: data.id,
            summary: typeof data.summary === "string" ? data.summary : "",
            state,
          });
        }
      }
    }
    return out;
  }

  return { configured: llm !== null, refusal, quota, send, items };
}

export type Chat = ReturnType<typeof createChat>;
export { LlmError };
