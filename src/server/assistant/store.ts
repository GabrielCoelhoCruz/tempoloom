// Storage of assistant chat (docs/specs/assistant-chat.md): conversations and
// their messages (rule 11), chat memories (rules 22-25) and the use per user
// and day (rule 27). Migration 51 has the tables.
import { randomUUID } from "node:crypto";
import { all, type Db, one, run, tx } from "../db.ts";
import type { LlmMessage, ToolCall } from "../llm.ts";

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

interface MessageRow {
  role: "user" | "assistant" | "tool";
  content: string | null;
  tool_calls: string | null;
  tool_call_id: string | null;
}

/** The messages of a conversation, oldest first, in the chat completions format. */
export function messagesOf(db: Db, conversationId: string): LlmMessage[] {
  return all<MessageRow>(
    db,
    "SELECT role, content, tool_calls, tool_call_id FROM assistant_messages WHERE conversation_id = ? ORDER BY seq",
    conversationId,
  ).map((r): LlmMessage => {
    if (r.role === "user") return { role: "user", content: r.content ?? "" };
    if (r.role === "tool")
      return { role: "tool", tool_call_id: r.tool_call_id ?? "", content: r.content ?? "" };
    return {
      role: "assistant",
      content: r.content,
      ...(r.tool_calls ? { tool_calls: JSON.parse(r.tool_calls) as ToolCall[] } : {}),
    };
  });
}

/**
 * Saves one finished turn: a new conversation when id is null, then the
 * messages after the stored ones. Returns the conversation id.
 */
export function saveTurn(
  db: Db,
  userId: string,
  id: string | null,
  messages: LlmMessage[],
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
        `INSERT INTO assistant_messages (conversation_id, seq, role, content, tool_calls, tool_call_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        cid,
        ++seq,
        m.role,
        m.content,
        m.role === "assistant" && m.tool_calls ? JSON.stringify(m.tool_calls) : null,
        m.role === "tool" ? m.tool_call_id : null,
        now,
      );
    }
  });
  return cid;
}

// ---------------------------------------------------------------- memories

export interface Memory {
  id: string;
  text: string;
  people: string[];
  createdAt: number;
}

const EMAIL = /[^\s<>(),;:"']+@[^\s<>(),;:"']+\.[a-z]{2,}/gi;

/** Rule 25: the people of a memory are the names the model gave and the emails in the text. */
export function addMemory(
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
    "INSERT INTO assistant_memories (id, user_id, text, people, created_at) VALUES (?, ?, ?, ?, ?)",
    id,
    userId,
    text,
    JSON.stringify(unique),
    now,
  );
  return { id, text, people: unique, createdAt: now };
}

export const memories = (db: Db, userId: string): Memory[] =>
  all<{ id: string; text: string; people: string; createdAt: number }>(
    db,
    "SELECT id, text, people, created_at AS createdAt FROM assistant_memories WHERE user_id = ? ORDER BY created_at, rowid",
    userId,
  ).map((m) => ({ ...m, people: JSON.parse(m.people) as string[] }));

export const deleteMemory = (db: Db, userId: string, id: string): boolean =>
  db.prepare("DELETE FROM assistant_memories WHERE id = ? AND user_id = ?").run(id, userId)
    .changes > 0;

// ---------------------------------------------------------------- use per day

export const usedOn = (db: Db, userId: string, day: string): number =>
  one<{ count: number }>(
    db,
    "SELECT count FROM assistant_usage WHERE user_id = ? AND day = ?",
    userId,
    day,
  )?.count ?? 0;

export function countUse(db: Db, userId: string, day: string): void {
  run(
    db,
    `INSERT INTO assistant_usage (user_id, day, count) VALUES (?, ?, 1)
     ON CONFLICT (user_id, day) DO UPDATE SET count = count + 1`,
    userId,
    day,
  );
  // Only today's count is read; older days are not needed.
  run(db, "DELETE FROM assistant_usage WHERE user_id = ? AND day < ?", userId, day);
}
