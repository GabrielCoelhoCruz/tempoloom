// Storage of assistant chat (docs/specs/assistant-chat.md): conversations and
// their messages (rule 11), chat memories (rules 22-25), resent messages and
// the use per user and day (rule 27). Migration 51 has the tables.
import { createHash, randomUUID } from "node:crypto";
import { all, type Db, one, run, tx } from "../db.ts";
import type { LlmMessage, ToolCall } from "../llm.ts";

const DAY = 86_400_000;

// ---------------------------------------------------------------- conversations

export interface Conversation {
  id: string;
  title: string;
  updatedAt: number;
}

export const conversations = (db: Db, userId: string): Conversation[] =>
  all<Conversation>(
    db,
    `SELECT id, title, updated_at AS updatedAt FROM assistant_conversations WHERE user_id = ?
     ORDER BY updated_at DESC, rowid DESC LIMIT 50`,
    userId,
  );

export const ownsConversation = (db: Db, userId: string, id: string) =>
  Boolean(
    one(db, "SELECT 1 FROM assistant_conversations WHERE id = ? AND user_id = ?", id, userId),
  );

/** What a message made: a staged change (preview mode) or a proposed memory. */
export interface Ref {
  kind: "proposal" | "memory";
  id: string;
}

/** A message with the link to what it made, as saved. */
export type StoredMessage = LlmMessage & { ref?: Ref | undefined };

interface MessageRow {
  role: "user" | "assistant" | "tool";
  content: string | null;
  tool_calls: string | null;
  tool_call_id: string | null;
  ref_kind: Ref["kind"] | null;
  ref_id: string | null;
}

/** The messages of a conversation, oldest first, with their links. */
export function messagesOf(db: Db, conversationId: string): StoredMessage[] {
  return all<MessageRow>(
    db,
    `SELECT role, content, tool_calls, tool_call_id, ref_kind, ref_id FROM assistant_messages
     WHERE conversation_id = ? ORDER BY seq`,
    conversationId,
  ).map((r): StoredMessage => {
    const ref = r.ref_kind && r.ref_id ? { ref: { kind: r.ref_kind, id: r.ref_id } } : {};
    if (r.role === "user") return { role: "user", content: r.content ?? "", ...ref };
    if (r.role === "tool")
      return { role: "tool", tool_call_id: r.tool_call_id ?? "", content: r.content ?? "", ...ref };
    return {
      role: "assistant",
      content: r.content,
      ...(r.tool_calls ? { tool_calls: JSON.parse(r.tool_calls) as ToolCall[] } : {}),
      ...ref,
    };
  });
}

/** A message in the chat completions format, without the link. */
export function forModel(m: StoredMessage): LlmMessage {
  const { ref: _, ...rest } = m;
  return rest as LlmMessage;
}

/**
 * Saves one turn: a new conversation when id is null, then the messages after
 * the stored ones. Returns the conversation id.
 */
export function saveTurn(
  db: Db,
  userId: string,
  id: string | null,
  messages: StoredMessage[],
  now: number,
): string {
  const cid = id ?? randomUUID();
  tx(db, () => {
    if (id === null) {
      const first = messages.find((m) => m.role === "user")?.content ?? "";
      const title = first.length > 60 ? `${first.slice(0, 59)}…` : first;
      run(
        db,
        "INSERT INTO assistant_conversations (id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        cid,
        userId,
        title,
        now,
        now,
      );
    } else run(db, "UPDATE assistant_conversations SET updated_at = ? WHERE id = ?", now, cid);
    let seq =
      one<{ n: number | null }>(
        db,
        "SELECT MAX(seq) AS n FROM assistant_messages WHERE conversation_id = ?",
        cid,
      )?.n ?? 0;
    for (const m of messages) {
      run(
        db,
        `INSERT INTO assistant_messages (conversation_id, seq, role, content, tool_calls, tool_call_id,
           ref_kind, ref_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        cid,
        ++seq,
        m.role,
        m.content,
        m.role === "assistant" && m.tool_calls ? JSON.stringify(m.tool_calls) : null,
        m.role === "tool" ? m.tool_call_id : null,
        m.ref?.kind ?? null,
        m.ref?.id ?? null,
        now,
      );
    }
  });
  return cid;
}

// ---------------------------------------------------------------- resent messages

/** A request seen before. A done request always has its conversation (a CHECK in migration 51). */
export type KnownRequest =
  | { state: "running" }
  | { state: "done"; conversationId: string }
  | { state: "failed"; conversationId: string | null; message: string };

interface RequestRow {
  state: KnownRequest["state"];
  conversation_id: string | null;
  message: string;
  fingerprint: string;
}

/** The hash a client message id is bound to: the conversation, the selected event and the text. */
export const fingerprintOf = (
  conversationId: string | null,
  eventId: string | null,
  text: string,
) =>
  createHash("sha256")
    .update(JSON.stringify([conversationId, eventId, text]))
    .digest("hex");

export const STUCK = "The earlier attempt of this message did not finish. Send it again.";

/**
 * Starts the request of a client message id, or gives the stored one when the
 * same message was sent before (a resend); "mismatch" when the id was used for
 * another message. A request still running after `staleMs` (the server stopped
 * during the turn) counts as failed. Requests of more than one day are pruned.
 */
export function startRequest(
  db: Db,
  userId: string,
  clientId: string,
  fingerprint: string,
  now: number,
  staleMs: number,
): KnownRequest | "mismatch" | null {
  return tx(db, () => {
    run(
      db,
      "DELETE FROM assistant_requests WHERE user_id = ? AND created_at < ?",
      userId,
      now - DAY,
    );
    run(
      db,
      `UPDATE assistant_requests SET state = 'failed', message = ?
       WHERE user_id = ? AND state = 'running' AND created_at < ?`,
      STUCK,
      userId,
      now - staleMs,
    );
    const known = one<RequestRow>(
      db,
      "SELECT state, conversation_id, message, fingerprint FROM assistant_requests WHERE user_id = ? AND client_id = ?",
      userId,
      clientId,
    );
    if (known) {
      if (known.fingerprint !== fingerprint) return "mismatch";
      if (known.state === "running") return { state: "running" };
      if (known.state === "done")
        return { state: "done", conversationId: known.conversation_id as string };
      return { state: "failed", conversationId: known.conversation_id, message: known.message };
    }
    run(
      db,
      "INSERT INTO assistant_requests (user_id, client_id, fingerprint, state, created_at) VALUES (?, ?, ?, 'running', ?)",
      userId,
      clientId,
      fingerprint,
      now,
    );
    return null;
  });
}

export function endRequest(
  db: Db,
  userId: string,
  clientId: string,
  end: { state: "done" | "failed"; conversationId: string | null; message?: string } | null,
): void {
  if (end === null)
    run(db, "DELETE FROM assistant_requests WHERE user_id = ? AND client_id = ?", userId, clientId);
  else
    run(
      db,
      "UPDATE assistant_requests SET state = ?, conversation_id = ?, message = ? WHERE user_id = ? AND client_id = ?",
      end.state,
      end.conversationId,
      end.message ?? "",
      userId,
      clientId,
    );
}

// ---------------------------------------------------------------- memories

export interface Memory {
  id: string;
  text: string;
  people: string[];
  state: "pending" | "saved";
  createdAt: number;
}

const EMAIL = /[^\s<>(),;:"']+@[^\s<>(),;:"']+\.[a-z]{2,}/gi;

/**
 * Rule 22: a memory the assistant proposes. It waits for the user's approval
 * (state pending) and reaches the model only when saved. Rule 25: its people
 * are the names the model gave and the emails in the text.
 */
export function proposeMemory(
  db: Db,
  userId: string,
  text: string,
  people: string[],
  now: number,
): Memory {
  const id = randomUUID();
  const found = [...people, ...(text.match(EMAIL) ?? [])].map((p) => p.trim());
  const unique = [...new Map(found.map((p) => [p.toLowerCase(), p])).values()];
  run(
    db,
    "INSERT INTO assistant_memories (id, user_id, text, people, state, created_at) VALUES (?, ?, ?, ?, 'pending', ?)",
    id,
    userId,
    text,
    JSON.stringify(unique),
    now,
  );
  return { id, text, people: unique, state: "pending", createdAt: now };
}

interface MemoryRow {
  id: string;
  text: string;
  people: string;
  state: Memory["state"];
  createdAt: number;
}
const memoryOf = (m: MemoryRow): Memory => ({ ...m, people: JSON.parse(m.people) as string[] });

/** The saved memories: the list (rule 23) and the model's prompt. */
export const memories = (db: Db, userId: string): Memory[] =>
  all<MemoryRow>(
    db,
    `SELECT id, text, people, state, created_at AS createdAt FROM assistant_memories
     WHERE user_id = ? AND state = 'saved' ORDER BY created_at, rowid`,
    userId,
  ).map(memoryOf);

export const memoryById = (db: Db, userId: string, id: string): Memory | undefined => {
  const m = one<MemoryRow>(
    db,
    "SELECT id, text, people, state, created_at AS createdAt FROM assistant_memories WHERE id = ? AND user_id = ?",
    id,
    userId,
  );
  return m && memoryOf(m);
};

const savedCount = (db: Db, userId: string) =>
  one<{ n: number }>(
    db,
    "SELECT count(*) AS n FROM assistant_memories WHERE user_id = ? AND state = 'saved'",
    userId,
  )?.n ?? 0;

/**
 * The user approves a proposed memory. With a limit of saved memories (plans
 * rule 4), the count and the save are one transaction.
 */
export const saveMemory = (
  db: Db,
  userId: string,
  id: string,
  limit: number | null = null,
): "saved" | "missing" | "limit" =>
  tx(db, () => {
    if (limit !== null && savedCount(db, userId) >= limit) {
      const pending = one(
        db,
        "SELECT 1 FROM assistant_memories WHERE id = ? AND user_id = ? AND state = 'pending'",
        id,
        userId,
      );
      return pending ? "limit" : "missing";
    }
    return db
      .prepare(
        "UPDATE assistant_memories SET state = 'saved' WHERE id = ? AND user_id = ? AND state = 'pending'",
      )
      .run(id, userId).changes > 0
      ? "saved"
      : "missing";
  });

/** Proposes a memory unless the user has `limit` saved ones; the check and the insert are one transaction. */
export const proposeMemoryWithin = (
  db: Db,
  userId: string,
  text: string,
  people: string[],
  now: number,
  limit: number | null,
): Memory | null =>
  tx(db, () =>
    limit !== null && savedCount(db, userId) >= limit
      ? null
      : proposeMemory(db, userId, text, people, now),
  );

/** Deletes a saved memory, or discards a proposed one. */
export const deleteMemory = (db: Db, userId: string, id: string): boolean =>
  db.prepare("DELETE FROM assistant_memories WHERE id = ? AND user_id = ?").run(id, userId)
    .changes > 0;

// ---------------------------------------------------------------- use per day

/** The UTC day of an instant: the quota's day, which the user's time zone does not move. */
export const utcDay = (t: number) => new Date(t).toISOString().slice(0, 10);

export const usedOn = (db: Db, userId: string, day: string): number =>
  one<{ count: number }>(
    db,
    "SELECT count FROM assistant_usage WHERE user_id = ? AND day = ?",
    userId,
    day,
  )?.count ?? 0;

/**
 * Counts one message before the model is called, in one statement with the
 * check: it adds 1 only while the count is below the limit. Returns false when
 * the limit is reached. A turn that fails later still counts.
 */
export function reserveUse(db: Db, userId: string, day: string, limit: number | null): boolean {
  const row = one<{ count: number }>(
    db,
    `INSERT INTO assistant_usage (user_id, day, count) VALUES (?, ?, 1)
     ON CONFLICT (user_id, day) DO UPDATE SET count = count + 1 WHERE count < ?
     RETURNING count`,
    userId,
    day,
    limit ?? Number.MAX_SAFE_INTEGER,
  );
  // Days a week old are not read again. The cut is in UTC, so a time zone change cannot reset it.
  run(
    db,
    "DELETE FROM assistant_usage WHERE user_id = ? AND day < ?",
    userId,
    utcDay(Date.parse(`${day}T00:00:00Z`) - 7 * DAY),
  );
  return row !== undefined;
}
