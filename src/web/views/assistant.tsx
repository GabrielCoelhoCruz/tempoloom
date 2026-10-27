// Assistant chat panel in the planner (docs/specs/assistant-chat.md). Requests
// in plain language; every change the assistant proposes waits in preview mode
// (assistant-preview-mode.md), where the user accepts it, discards it, or
// replies here (rule 13). The bookmark opens the memory list (rule 23).
import { signal } from "@preact/signals";
import type { ComponentChildren } from "preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { reviewRequest } from "../../shared/assistant-review.ts";
import { ApiError, api } from "../lib/api.ts";
import { takeAssistantLink } from "../lib/assistant-link.ts";
import { chatBlocks, type Inline, type Line } from "../lib/chat-text.ts";
import { useLive } from "../lib/live.ts";
import { chatDraft, plannerContext, sidePanel } from "../lib/planner-signals.ts";
import { onLinkClick } from "../lib/router.ts";
import { messageOf } from "../lib/save.ts";

type Item =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | {
      kind: "proposal";
      changeId: string;
      summary: string;
      state: string;
      description: string | null;
    }
  | { kind: "memory"; memoryId: string; text: string; state: "pending" | "saved" | "removed" };

interface Refusal {
  error: "not_configured" | "chat_disabled" | "quota";
  message: string;
  admins?: { name: string; email: string }[];
}

interface Memory {
  id: string;
  text: string;
  people: string[];
}

interface State {
  refusal: Refusal | null;
  conversations: { id: string; title: string }[];
  conversationId: string | null;
  items: Item[];
  memories: Memory[];
  /** How long to wait for a running message: the server's turn deadline and its margin. */
  waitMs: number;
}

interface Answer {
  conversationId: string;
  items: Item[];
}

interface MessageBody {
  conversationId: string | null;
  clientId: string;
  text: string;
  context: { from?: string; to?: string; eventId?: string };
}

/**
 * Posts a message. While the first send of the same message still runs on the
 * server (409 in_progress: its answer was lost), asks again with the same id
 * every POLL_MS, at most `waitMs`, so no second turn starts. `signal` stops
 * the wait (the panel closed).
 */
async function postMessage(
  body: MessageBody,
  waitMs: number,
  signal: AbortSignal,
  onWaiting: () => void,
): Promise<Answer> {
  const started = Date.now();
  for (;;) {
    try {
      return await api<Answer>("POST", "/api/assistant/messages", body);
    } catch (err) {
      const busy =
        err instanceof ApiError &&
        err.status === 409 &&
        (err.body as { error?: string } | undefined)?.error === "in_progress";
      if (!busy || signal.aborted || Date.now() - started > waitMs) throw err;
      onWaiting();
      await new Promise((r) => setTimeout(r, POLL_MS));
      if (signal.aborted) throw err;
    }
  }
}

/** A random message id; getRandomValues also works on plain HTTP, randomUUID does not. */
const newId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");

/** How often the panel asks again while the first send of a message runs. */
const POLL_MS = 2_000;

/** The open conversation, kept while the panel is closed; "new" starts one. */
const current = signal<string | null>(null);
/** Counts the user's picks of a conversation (New chat, the list): a pick makes the next message new. */
const picks = signal(0);
const pick = (conversation: string) => {
  current.value = conversation;
  picks.value++;
};

/** Rule 18: a digest link opens the panel on its conversation, with its staged fixes, once. */
export function openFromLink(): void {
  const id = takeAssistantLink();
  if (!id) return;
  pick(id);
  sidePanel.value = "assistant";
}

const STATE_WORDS: Record<string, string> = {
  pending: "Waiting for your approval",
  accepted: "Accepted, apply in preview mode",
  discarded: "Discarded",
  applied: "Applied",
  stale: "Skipped: the event changed",
  replaced: "Replaced by a later proposal",
  merged: "Merged into the next proposal",
  failed: "Failed",
  expired: "Expired",
};

const nodes = (parts: Inline[]): ComponentChildren[] =>
  parts.map((p) =>
    typeof p === "string" ? (
      p
    ) : p.t === "code" ? (
      <code>{p.text}</code>
    ) : p.t === "strong" ? (
      <strong>{nodes(p.children)}</strong>
    ) : (
      <em>{nodes(p.children)}</em>
    ),
  );
const lines = (ls: Line[]) =>
  ls.flatMap((l, j) => (j === 0 ? nodes(l) : [<br key={`br${j}`} />, ...nodes(l)]));

/** An assistant reply as elements: the safe markdown of lib/chat-text.ts. */
function Reply({ text }: { text: string }) {
  return (
    <>
      {chatBlocks(text).map((b, i) =>
        b.t === "p" ? (
          <p key={i}>{lines(b.lines)}</p>
        ) : b.t === "ul" ? (
          <ul key={i}>
            {b.items.map((it, j) => (
              <li key={j}>{lines(it)}</li>
            ))}
          </ul>
        ) : (
          <ol key={i} start={b.start}>
            {b.items.map((it, j) => (
              <li key={j}>{lines(it)}</li>
            ))}
          </ol>
        ),
      )}
    </>
  );
}

export function AssistantPanel() {
  const [state, setState] = useState<State | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showMemories, setShowMemories] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const seq = useRef(0);
  // The message being sent: its id, its text, its selected event, and the
  // conversation it went to. A resend after a lost answer sends the same body,
  // also when a reload of the panel showed the conversation the first send made.
  // Only another text, another event or the user's pick of a conversation makes
  // a new message.
  const message = useRef<(MessageBody & { pick: number }) | null>(null);
  const [waiting, setWaiting] = useState(false);
  // Stops a wait for a running message when the panel closes.
  const alive = useRef(new AbortController());
  useEffect(() => () => alive.current.abort(), []);

  const load = useCallback(async () => {
    const n = ++seq.current;
    const q = current.value ? `?conversation=${encodeURIComponent(current.value)}` : "";
    const s = await api<State>("GET", `/api/assistant${q}`);
    if (n !== seq.current) return;
    setState(s);
  }, []);
  useEffect(() => {
    void load();
    const again = () => void load();
    addEventListener("tl-staged", again);
    return () => removeEventListener("tl-staged", again);
  }, [load]);
  useLive(load);

  // "Reply in chat" in preview mode puts its text in the draft.
  useEffect(() => {
    if (chatDraft.value === null) return;
    setDraft(chatDraft.value);
    chatDraft.value = null;
    input.current?.focus();
  }, [chatDraft.value]);

  /** Sends the draft, or `fixed` (the Recommendations action) and keeps the draft. */
  const send = async (fixed?: string) => {
    const text = (fixed ?? draft).trim();
    if (!text || sending || !state) return;
    setSending(true);
    setError(null);
    setWaiting(false);
    const ctx = plannerContext.value;
    const context = {
      ...(ctx.from ? { from: ctx.from, to: ctx.to } : {}),
      ...(ctx.eventId ? { eventId: ctx.eventId } : {}),
    };
    const bound = message.current;
    const body =
      bound &&
      bound.text === text &&
      bound.context.eventId === context.eventId &&
      bound.pick === picks.value
        ? bound
        : {
            conversationId: state.conversationId,
            clientId: newId(),
            text,
            context,
            pick: picks.value,
          };
    message.current = body;
    const { pick: _, ...sent } = body;
    const shown = (r: { conversationId?: string; items?: Item[] }) => {
      if (!r.conversationId || !r.items) return;
      current.value = r.conversationId;
      seq.current++;
      setState({ ...state, conversationId: r.conversationId, items: r.items });
    };
    const signal = alive.current.signal;
    try {
      const r = await postMessage(sent, state.waitMs, signal, () => setWaiting(true));
      if (signal.aborted) return;
      message.current = null;
      if (fixed === undefined) setDraft("");
      shown(r);
    } catch (err) {
      if (signal.aborted) return;
      // Edge case 5: show the error and keep the draft.
      const answer =
        err instanceof ApiError
          ? (err.body as
              | { error?: string; message?: string; conversationId?: string; items?: Item[] }
              | undefined)
          : undefined;
      // The server answered this message (failed, refused, id used): the next send
      // is a new message. Without an answer (network, proxy) or while it still
      // runs, the same message makes the resend safe.
      if (answer?.error && answer.error !== "in_progress") message.current = null;
      // Steps that ran before the failure may have proposed changes: show them.
      if (answer) shown(answer);
      setError(answer?.message ?? (err instanceof Error ? err.message : String(err)));
    } finally {
      if (!signal.aborted) {
        setSending(false);
        setWaiting(false);
        // The preview panel reads the staged changes again.
        dispatchEvent(new Event("tl-staged"));
        void load();
      }
    }
  };

  const decideMemory = async (id: string, save: boolean) => {
    setError(null);
    try {
      if (save) await api("POST", `/api/assistant/memories/${id}/save`);
      else await api("DELETE", `/api/assistant/memories/${id}`);
    } catch (err) {
      // A refusal names its reason, as the memory limit (plans rule 4).
      setError(messageOf(err));
    }
    void load();
  };

  const decide = async (id: string, decision: "accept" | "discard") => {
    setError(null);
    try {
      await api("POST", `/api/preview/${id}/${decision}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    dispatchEvent(new Event("tl-staged"));
  };

  const close = () => (sidePanel.value = null);
  const refusal = state?.refusal;
  const blocked = refusal && refusal.error !== "quota";

  return (
    <aside class="drawer assistant" data-testid="assistant-panel" aria-label="Assistant">
      <div class="assistant-head">
        <h2>Assistant</h2>
        <span class="spacer" />
        {state && !blocked && (
          <button
            type="button"
            // Rules 19, 20: the dates shown in the planner; none shown, no review.
            disabled={sending || !plannerContext.value.from}
            title="Review the dates shown in the planner and stage fixes"
            onClick={() => {
              // Rules 19, 20: the review covers the dates shown in the planner.
              const ctx = plannerContext.value;
              setShowMemories(false);
              void send(reviewRequest(ctx.from, ctx.to));
            }}
          >
            Recommendations
          </button>
        )}
        {state && !blocked && (
          <button
            type="button"
            onClick={() => {
              pick("new");
              setShowMemories(false);
              void load();
            }}
          >
            New chat
          </button>
        )}
        <button
          type="button"
          class="icon"
          aria-label="Memories"
          aria-pressed={showMemories}
          title="Memories"
          onClick={() => setShowMemories(!showMemories)}
        >
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <path d="M6 3h12v18l-6-4-6 4z" fill="none" stroke="currentColor" stroke-width="2" />
          </svg>
        </button>
        <button type="button" onClick={close}>
          Close
        </button>
      </div>
      {!state ? null : showMemories ? (
        <MemoryList memories={state.memories} onChange={load} />
      ) : blocked ? (
        <div class="notice" role="status" data-testid="assistant-refusal">
          <p>{refusal.message}</p>
          {refusal.error === "chat_disabled" && (
            <details data-testid="team-admins">
              <summary>
                <a href="/team" onClick={(e) => e.preventDefault()}>
                  Who are the team admins?
                </a>
              </summary>
              <ul>
                {(refusal.admins ?? []).map((a) => (
                  <li key={a.email}>
                    {a.name || a.email} ({a.email})
                  </li>
                ))}
              </ul>
              <a href="/team" onClick={onLinkClick}>
                Open the team page
              </a>
            </details>
          )}
        </div>
      ) : (
        <>
          {state.conversations.length > 1 && (
            <label class="inline">
              Conversation
              <select
                value={state.conversationId ?? ""}
                onChange={(e) => {
                  pick(e.currentTarget.value || "new");
                  void load();
                }}
              >
                {state.conversationId === null && <option value="">New chat</option>}
                {state.conversations.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title || "Untitled"}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div class="assistant-log" data-testid="assistant-log">
            {state.items.length === 0 && (
              <p class="status">
                Ask about your calendar, or ask for a change. Every change waits for your approval
                in preview mode.
              </p>
            )}
            {state.items.map((item, i) => {
              if (item.kind === "user")
                return (
                  <div key={i} class="msg user" data-testid="chat-user">
                    {item.text}
                  </div>
                );
              if (item.kind === "assistant")
                return (
                  <div key={i} class="msg bot" data-testid="chat-assistant">
                    <Reply text={item.text} />
                  </div>
                );
              if (item.kind === "memory")
                return item.state === "pending" ? (
                  <div key={i} class="proposal" data-testid="chat-memory">
                    <strong>Remember: {item.text}</strong>
                    <div class="meta">Save this memory? It shapes suggestions only.</div>
                    <div class="actions">
                      <button type="button" onClick={() => void decideMemory(item.memoryId, true)}>
                        Save memory
                      </button>
                      <button type="button" onClick={() => void decideMemory(item.memoryId, false)}>
                        Discard
                      </button>
                    </div>
                  </div>
                ) : (
                  <div key={i} class="msg note" data-testid="chat-memory">
                    {item.state === "saved" ? `Saved to memories: ${item.text}` : "Memory removed"}
                  </div>
                );
              const open = item.state === "pending" || item.state === "accepted";
              return (
                <div key={i} class="proposal" data-testid="chat-proposal">
                  <strong>{item.summary}</strong>
                  {item.description !== null && (
                    <pre
                      class="new-description"
                      title="New description"
                      data-testid="proposal-description"
                    >
                      {item.description}
                    </pre>
                  )}
                  <div class="meta" data-testid="proposal-state">
                    {STATE_WORDS[item.state] ?? item.state}
                  </div>
                  {open && (
                    <div class="actions">
                      {item.state === "pending" && (
                        <button type="button" onClick={() => void decide(item.changeId, "accept")}>
                          Accept
                        </button>
                      )}
                      <button type="button" onClick={() => void decide(item.changeId, "discard")}>
                        Discard
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setDraft(`About “${item.summary}”: `);
                          input.current?.focus();
                        }}
                      >
                        Reply
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
            {sending && (
              <p class="status" data-testid="assistant-thinking">
                {waiting ? "Still answering your earlier send of this message…" : "Thinking…"}
              </p>
            )}
          </div>
          {refusal?.error === "quota" && (
            <p class="error" role="alert" data-testid="assistant-limit">
              {refusal.message}
            </p>
          )}
          {error && (
            <p class="error" role="alert" data-testid="assistant-error">
              {error}
            </p>
          )}
          <form
            class="assistant-form"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <textarea
              ref={input}
              aria-label="Message to the assistant"
              rows={3}
              value={draft}
              onInput={(e) => setDraft(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <button type="submit" class="primary" disabled={sending || !draft.trim()}>
              Send
            </button>
          </form>
        </>
      )}
    </aside>
  );
}

function MemoryList({ memories, onChange }: { memories: Memory[]; onChange: () => void }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <div class="list" data-testid="memory-list">
      <h3>Memories</h3>
      <p class="status">
        Tell the assistant “remember …” to add one. Memories shape suggestions only; they never
        change your calendar on their own.
      </p>
      {memories.length === 0 && <p class="status">No memories.</p>}
      {memories.map((m) => (
        <div class="row" key={m.id} data-testid="memory">
          <span>{m.text}</span>
          <button
            type="button"
            onClick={async () => {
              setError(null);
              try {
                await api("DELETE", `/api/assistant/memories/${m.id}`);
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
              }
              onChange();
            }}
          >
            Delete
          </button>
        </div>
      ))}
      {error && (
        <p class="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
