// Assistant chat (docs/specs/assistant-chat.md): one turn runs the model with
// the chat tools until it answers in text. Tool calls run through the same
// callTool as the MCP server; write tools only propose (rule 12). A finished
// turn is saved, so a reload shows the conversation and the next turn has its
// context (rule 11).
//
// Limits of a turn: MAX_STEPS model calls, one deadline for the whole turn
// (turnMs), and a stop when the client leaves. A turn that fails before any
// tool ran saves nothing and the panel keeps the draft (edge case 5); one that
// fails later saves the steps that ran, so the panel shows what they proposed.
// A message id from the client makes a resend give the same answer.
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { reviewRequest } from "../../shared/assistant-review.ts";
import type { User } from "../accounts.ts";
import { all, type Db, one } from "../db.ts";
import { instanceLimit, limitMessage } from "../limits.ts";
import { type Llm, LlmError, type LlmMessage } from "../llm.ts";
import { cached } from "../mcp/reads.ts";
import { type Caller, callTool, type Tool } from "../mcp/rpc.ts";
import {
  type ChangeKind,
  MERGED,
  newDescription,
  REPLACED,
  userFormatsOf,
  whenAt,
  zoneOf,
} from "../preview.ts";
import { membership } from "../teams.ts";
import { reportingOf } from "./people.ts";
import { type PromptInput, systemPrompt } from "./prompt.ts";
import {
  endRequest,
  expireMemories,
  fingerprintOf,
  forModel,
  memories,
  memoryById,
  messagesOf,
  ownsConversation,
  type Ref,
  reserveUse,
  type StoredMessage,
  saveTurn,
  startRequest,
  usedOn,
  utcDay,
} from "./store.ts";
import { type ChatTool, llmTool } from "./tools.ts";

const DAY = 86_400_000;
/** Model calls in one turn, at most: a turn that needs more stops with a note. */
export const MAX_STEPS = 8;
/** Characters of stored history sent as context, at most; older messages are cut at a user message. */
export const MAX_HISTORY_CHARS = 48_000;
/** Characters of tool results kept in the history; older results are replaced by a short note. */
export const MAX_TOOL_CHARS = 16_000;
/** Tool calls of one reply that run, at most; the others get TOO_MANY_CALLS. */
export const MAX_CALLS_PER_REPLY = 20;
export const TOO_MANY_CALLS = `Error: not run. At most ${MAX_CALLS_PER_REPLY} tool calls of one reply run; ask again for the rest.`;
/** Characters of one text of the latest turn, when that turn alone is over the budget. */
export const MAX_TEXT_CHARS = 4_000;
export const OMITTED_ARGUMENTS = JSON.stringify({ omitted: "arguments too long to keep" });
export const OMITTED = "[Result omitted to save space. Call the tool again if you need it.]";
/** Milliseconds a whole turn may take, by default: below the 60 s read timeout of common proxies. */
export const TURN_MS = 55_000;

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
  | {
      kind: "proposal";
      changeId: string;
      summary: string;
      state: string;
      /** The full new description of an event, shown before approval. */
      description: string | null;
    }
  | { kind: "memory"; memoryId: string; text: string; state: "pending" | "saved" | "removed" };

export interface ChatDeps {
  db: Db;
  llm: Llm | null;
  tools: ChatTool[];
  now: () => number;
  turnMs?: number;
}

export interface SendBody {
  conversationId?: string | null | undefined;
  text: string;
  context?: ChatContext | undefined;
  /** The client's id of this message; a resend with the same id gives the same answer. */
  clientId?: string | undefined;
}

/** How the turn runs: the daily review is unattended and has its own time limit. */
interface TurnMode {
  unattended?: boolean;
  turnMs?: number;
}

/** The client label of the daily review's changes in preview mode. */
export const DAILY_REVIEW_CLIENT = "daily review";

/**
 * The tools of the unattended daily review: reads, and fixes of single events
 * (move, answer, video link). No automation, policy, delete, new event or
 * memory: calendar text from other people reaches this turn. A list of
 * argument names narrows a tool: propose_update_event only moves (no title,
 * no description text), and propose_video_link adds only a video link.
 */
export const REVIEW_TOOLS: ReadonlyMap<string, readonly string[] | null> = new Map([
  ["list_events", null],
  ["find_meeting_time", null],
  ["get_meeting_context", null],
  ["review_schedule", null],
  ["propose_update_event", ["event_id", "start", "end", "reason"]],
  ["propose_rsvp", null],
  ["propose_video_link", null],
]);

/** A tool as the model sees it, with only the arguments `keep` names. */
function narrowed(t: Tool, keep: readonly string[] | null): Tool {
  if (!keep) return t;
  const shape = t.input.shape;
  const fields = keep.filter((k) => k in shape).map((k) => [k, shape[k]]);
  return { ...t, input: z.object(Object.fromEntries(fields)) };
}

/** A request still running this long after the turn's deadline was cut off (the server stopped). */
const STALE_MARGIN_MS = 30_000;

type TurnResult =
  | { ok: true; conversationId: string }
  | { ok: false; conversationId: string | null; error: LlmError };

export type SendResult =
  | { kind: "ok"; conversationId: string; items: ChatItem[] }
  | { kind: "refused"; refusal: ChatRefusal }
  | { kind: "in_progress" }
  | { kind: "mismatch" }
  | { kind: "failed"; message: string; conversationId: string | null; items: ChatItem[] };
const size = (m: LlmMessage) =>
  (m.content?.length ?? 0) +
  (m.role === "assistant" ? JSON.stringify(m.tool_calls ?? []).length : 0);

export function createChat(deps: ChatDeps) {
  const { db, llm, tools, now } = deps;
  const turnMs = deps.turnMs ?? TURN_MS;
  /** How long a client should wait for a running message before the server calls it stuck. */
  const waitMs = turnMs + STALE_MARGIN_MS;
  const byName = new Map(tools.map((t) => [t.tool.name, t]));
  const llmTools = tools.map((t) => llmTool(t.tool));

  /** The quota's day (UTC) and when the next one starts. */
  function quotaDay() {
    const day = utcDay(now());
    return { day, next: Date.parse(`${day}T00:00:00Z`) + DAY };
  }

  function quotaRefusal(user: User, limit: number): ChatRefusal {
    const { next } = quotaDay();
    return {
      error: "quota",
      limit,
      resetsAt: next,
      message: `${limitMessage("assistant_chat_quota", limit)} You reached it today. It resets at ${whenAt(zoneOf(db, user.id), next, userFormatsOf(db, user.id))}.`,
    };
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
    if (limit !== null && usedOn(db, user.id, quotaDay().day) >= limit)
      return quotaRefusal(user, limit);
    return null;
  }

  function quota(user: User) {
    const limit = instanceLimit(db, "assistant_chat_quota");
    if (limit === null) return null;
    const q = quotaDay();
    return { limit, used: usedOn(db, user.id, q.day), resetsAt: q.next };
  }

  function promptInput(user: User, ctx: ChatContext, unattended = false): PromptInput {
    const date = /^\d{4}-\d{2}-\d{2}$/;
    const shown =
      ctx.from && ctx.to && date.test(ctx.from) && date.test(ctx.to)
        ? { from: ctx.from, to: ctx.to }
        : undefined;
    return {
      email: user.email,
      zone: zoneOf(db, user.id),
      now: now(),
      shown,
      selected: ctx.eventId ? selectedEvent(user.id, ctx.eventId) : undefined,
      memories: memories(db, user.id),
      reporting: reportingOf(db, user.id),
      unattended,
    };
  }

  /** The selected event, if it is the user's: a calendar event or a planned one. */
  function selectedEvent(userId: string, id: string) {
    const e = cached(db, userId, id);
    if (e) return { id, title: e.summary, start: e.start_ms, end: e.end_ms };
    const m = one<{ title: string; start_ms: number; end_ms: number }>(
      db,
      "SELECT title, start_ms, end_ms FROM managed_events WHERE id = ? AND user_id = ?",
      id,
      userId,
    );
    return m && { id, title: m.title, start: m.start_ms, end: m.end_ms };
  }

  /**
   * The stored context, newest first within MAX_HISTORY_CHARS: tool results
   * past MAX_TOOL_CHARS become OMITTED (the call and result pair stays), and
   * the context starts at a user message. The latest stored turn always stays:
   * when it alone is over the budget, its tool results become OMITTED and its
   * texts are cut.
   */
  function history(conversationId: string | null): LlmMessage[] {
    if (!conversationId) return [];
    const stored = messagesOf(db, conversationId).map(forModel);
    const out: LlmMessage[] = [];
    let total = 0;
    let toolChars = 0;
    for (let i = stored.length - 1; i >= 0; i--) {
      let m = stored[i] as LlmMessage;
      if (m.role === "tool") {
        toolChars += m.content.length;
        if (toolChars > MAX_TOOL_CHARS) m = { ...m, content: OMITTED };
      }
      total += size(m);
      if (total > MAX_HISTORY_CHARS) break;
      out.unshift(m);
    }
    while (out.length && out[0]?.role !== "user") out.shift();
    if (out.length) return out;
    const last = stored.map((m) => m.role).lastIndexOf("user");
    if (last < 0) return [];
    const cut = (t: string) => (t.length > MAX_TEXT_CHARS ? `${t.slice(0, MAX_TEXT_CHARS)}…` : t);
    return stored.slice(last).map((m): LlmMessage => {
      if (m.role === "tool") return { ...m, content: OMITTED };
      if (m.role === "user" || m.role === "system") return { ...m, content: cut(m.content) };
      return {
        ...m,
        content: m.content === null ? null : cut(m.content),
        ...(m.tool_calls
          ? {
              tool_calls: m.tool_calls.map((c) =>
                c.function.arguments.length > MAX_TEXT_CHARS
                  ? { ...c, function: { ...c.function, arguments: OMITTED_ARGUMENTS } }
                  : c,
              ),
            }
          : {}),
      };
    });
  }

  async function runTool(
    caller: Caller,
    name: string,
    raw: string,
    allowed: ReadonlyMap<string, readonly string[] | null> | undefined,
  ): Promise<{ content: string; ref?: Ref | undefined }> {
    const t = allowed && !allowed.has(name) ? undefined : byName.get(name);
    if (!t) return { content: `Error: there is no tool ${name}.` };
    let args: unknown;
    try {
      args = raw.trim() ? JSON.parse(raw) : {};
    } catch {
      return { content: "Error: the arguments are not valid JSON." };
    }
    const keep = allowed?.get(name);
    const extra =
      keep && args && typeof args === "object"
        ? Object.keys(args).filter((k) => !keep.includes(k))
        : [];
    if (extra.length > 0)
      return {
        content: `Error: here ${name} takes only ${keep?.join(", ")}; ${extra.join(", ")} cannot change. Nothing was staged.`,
      };
    const r = await callTool(t.tool, caller, args, t.failed);
    if (r.isError) return { content: `Error: ${r.text}` };
    return { content: r.text, ref: t.ref?.(r.data) };
  }

  /**
   * Runs one turn until the model answers, the steps run out, the deadline
   * passes or `signal` stops it. Returns the saved conversation (null when a
   * failure came before any tool ran) and the error, if any.
   */
  async function turn(
    user: User,
    conversationId: string | null,
    text: string,
    ctx: ChatContext,
    signal?: AbortSignal,
    mode: TurnMode = {},
  ): Promise<TurnResult> {
    if (!llm) throw new Error("not configured");
    if (conversationId && !ownsConversation(db, user.id, conversationId)) conversationId = null;
    const stop = new AbortController();
    const timer = setTimeout(
      () =>
        stop.abort(new LlmError("The turn took too long. Ask again in smaller parts.", "timeout")),
      mode.turnMs ?? turnMs,
    );
    const left = () =>
      stop.abort(new LlmError("The connection closed before the answer was ready.", "stopped"));
    if (signal?.aborted) left();
    signal?.addEventListener("abort", left, { once: true });
    const caller: Caller = mode.unattended
      ? { user, client: DAILY_REVIEW_CLIENT, source: "assistant_chat", unattended: true }
      : { user, client: "", source: "assistant_chat" };
    const allowed = mode.unattended ? REVIEW_TOOLS : undefined;
    const offered = allowed
      ? tools
          .filter((t) => allowed.has(t.tool.name))
          .map((t) => llmTool(narrowed(t.tool, allowed.get(t.tool.name) ?? null)))
      : llmTools;
    const base: LlmMessage[] = [
      { role: "system", content: systemPrompt(promptInput(user, ctx, mode.unattended)) },
      ...history(conversationId),
    ];
    // Finished steps: an assistant message with all its tool results.
    const steps: StoredMessage[] = [{ role: "user", content: text }];
    let toolsRan = false;
    try {
      let answered = false;
      for (let step = 0; step < MAX_STEPS; step++) {
        // The deadline and the client's leave are checked here, between steps.
        if (stop.signal.aborted) throw stop.signal.reason;
        const reply = await llm.complete([...base, ...steps.map(forModel)], offered, stop.signal);
        if (!reply.tool_calls?.length) {
          steps.push(reply);
          answered = true;
          break;
        }
        // The tools of one reply all run (they are local and short), and the
        // step is kept before the next check of the deadline: a stop comes only
        // between steps, so every change a step proposed is saved with its link.
        steps.push(reply);
        toolsRan = true;
        for (const [i, call] of reply.tool_calls.entries()) {
          // Calls past the cap get an error result, so the history stays valid.
          const r =
            i < MAX_CALLS_PER_REPLY
              ? await runTool(caller, call.function.name, call.function.arguments, allowed)
              : { content: TOO_MANY_CALLS, ref: undefined };
          steps.push({ role: "tool", tool_call_id: call.id, content: r.content, ref: r.ref });
        }
      }
      if (!answered)
        steps.push({
          role: "assistant",
          content: "I stopped: this request needed too many steps. Please ask in smaller parts.",
        });
      return { ok: true, conversationId: saveTurn(db, user.id, conversationId, steps, now()) };
    } catch (err) {
      if (!(err instanceof LlmError)) throw err;
      if (!toolsRan) return { ok: false, conversationId: null, error: err };
      // Steps that ran may have proposed changes: save them, so the panel shows them.
      steps.push({
        role: "assistant",
        content: `I stopped: ${err.message} What I proposed above waits for your approval.`,
      });
      return {
        ok: false,
        conversationId: saveTurn(db, user.id, conversationId, steps, now()),
        error: err,
      };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", left);
    }
  }

  /** A message: the checks, the idempotent request, the quota, then the turn. The route maps it to HTTP. */
  async function send(user: User, body: SendBody, signal?: AbortSignal): Promise<SendResult> {
    const shown = (cid: string | null) => (cid ? items(user.id, cid) : []);
    const refused = refusal(user);
    if (refused && refused.error !== "quota") return { kind: "refused", refusal: refused };
    const conversationId = body.conversationId ?? null;
    const clientId = body.clientId ?? randomUUID();
    const known = startRequest(
      db,
      user.id,
      clientId,
      fingerprintOf(conversationId, body.context?.eventId ?? null, body.text),
      now(),
      waitMs,
    );
    if (known === "mismatch") return { kind: "mismatch" };
    if (known?.state === "running") return { kind: "in_progress" };
    if (known?.state === "done")
      return {
        kind: "ok",
        conversationId: known.conversationId,
        items: shown(known.conversationId),
      };
    if (known)
      return {
        kind: "failed",
        message: known.message,
        conversationId: known.conversationId,
        items: shown(known.conversationId),
      };
    // Counted before the model call, in one statement with the check (rule 27).
    const limit = instanceLimit(db, "assistant_chat_quota");
    if (!reserveUse(db, user.id, quotaDay().day, limit)) {
      endRequest(db, user.id, clientId, null);
      return { kind: "refused", refusal: quotaRefusal(user, limit ?? 0) };
    }
    let r: TurnResult;
    try {
      r = await turn(user, conversationId, body.text, body.context ?? {}, signal);
    } catch (err) {
      endRequest(db, user.id, clientId, null);
      throw err;
    }
    if (r.ok) {
      endRequest(db, user.id, clientId, { state: "done", conversationId: r.conversationId });
      return { kind: "ok", conversationId: r.conversationId, items: shown(r.conversationId) };
    }
    const { message } = r.error;
    // The text names no URL and no key (src/server/llm.ts).
    console.error(`Assistant chat: ${message}`);
    endRequest(db, user.id, clientId, {
      state: "failed",
      conversationId: r.conversationId,
      message,
    });
    return {
      kind: "failed",
      message,
      conversationId: r.conversationId,
      items: shown(r.conversationId),
    };
  }

  /**
   * The items the panel shows for a conversation, with each proposal's current
   * state. An expired memory proposal shows as removed.
   */
  function items(userId: string, conversationId: string): ChatItem[] {
    expireMemories(db, userId, now());
    const out: ChatItem[] = [];
    for (const m of messagesOf(db, conversationId)) {
      if (m.role === "user") out.push({ kind: "user", text: m.content });
      else if (m.role === "assistant" && m.content?.trim())
        out.push({ kind: "assistant", text: m.content });
      if (m.ref?.kind === "proposal") {
        const c = one<{
          summary: string;
          state: string;
          result: string;
          kind: ChangeKind;
          after: string;
        }>(
          db,
          "SELECT summary, state, result, kind, after FROM staged_changes WHERE id = ? AND user_id = ?",
          m.ref.id,
          userId,
        );
        out.push({
          kind: "proposal",
          changeId: m.ref.id,
          summary: c?.summary ?? "A change that expired",
          // The chat says when a later proposal replaced or merged this one.
          state:
            c?.state === "discarded" && c.result === REPLACED
              ? "replaced"
              : c?.state === "discarded" && c.result === MERGED
                ? "merged"
                : (c?.state ?? "expired"),
          description: c ? newDescription({ kind: c.kind, after: JSON.parse(c.after) }) : null,
        });
      } else if (m.ref?.kind === "memory") {
        const mem = memoryById(db, userId, m.ref.id);
        out.push({
          kind: "memory",
          memoryId: m.ref.id,
          text: mem?.text ?? "",
          state: mem?.state ?? "removed",
        });
      }
    }
    return out;
  }

  /**
   * Rules 15, 16, 18: the review of the days from `from` to `toExclusive` in a
   * new conversation, as the Recommendations action asks it; the fixes the
   * model proposes wait in preview mode. Nobody watches it, so it offers only
   * REVIEW_TOOLS, keeps preview mode as it is and leaves the user's own open
   * changes alone. The system starts it, so it does not count toward the
   * user's quota. `conversationId` is null when chat is off for the user or
   * the model failed before it proposed anything; `complete` is false when
   * the turn stopped early.
   */
  async function review(
    user: User,
    from: string,
    toExclusive: string,
    opts: { turnMs?: number } = {},
  ): Promise<{ conversationId: string | null; complete: boolean }> {
    const refused = refusal(user);
    if (refused && refused.error !== "quota") return { conversationId: null, complete: false };
    const r = await turn(
      user,
      null,
      reviewRequest(from, toExclusive),
      { from, to: toExclusive },
      undefined,
      { unattended: true, ...(opts.turnMs ? { turnMs: opts.turnMs } : {}) },
    );
    // The text names no URL and no key (src/server/llm.ts).
    if (!r.ok) console.error(`Assistant review: ${r.error.message}`);
    return { conversationId: r.conversationId, complete: r.ok };
  }

  return { configured: llm !== null, refusal, quota, send, items, review, waitMs };
}

export type Chat = ReturnType<typeof createChat>;
export type Review = Chat["review"];
export { LlmError };
