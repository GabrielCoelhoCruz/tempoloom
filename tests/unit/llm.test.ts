// The client of the OpenAI-compatible endpoint (src/server/llm.ts) and the turn
// loop of assistant chat (src/server/assistant/chat.ts).
//
// Ways it can fail:
// 1. The request goes to the wrong path, without the bearer key, or without
//    the tools in the function calling format.
// 2. A tool call with object arguments, or without an id, is lost.
// 3. An error, a timeout or a broken answer hangs, or its text (shown to the
//    user and logged) holds the key or the base URL.
// 4. The loop does not run the tools, sends no tool results back, or runs
//    forever when the model keeps calling tools.
// 5. A chat write tool writes instead of staging, or stages as an AI tool.
// 6. A failed turn saves half a conversation; a finished one loses its history.
// 7. A key reaches the server log on a failed turn.
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureUser, type User } from "../../src/server/accounts.ts";
import { assistantRoutes } from "../../src/server/api/assistant.ts";
import type { AppEnv } from "../../src/server/app.ts";
import { createChat, MAX_STEPS } from "../../src/server/assistant/chat.ts";
import { messagesOf } from "../../src/server/assistant/store.ts";
import { chatTools } from "../../src/server/assistant/tools.ts";
import { all, openDb } from "../../src/server/db.ts";
import { createLlm, type Llm, LlmError, type LlmMessage } from "../../src/server/llm.ts";
import { createPreview, type PreviewDeps } from "../../src/server/preview.ts";

const KEY = "sk-secret-key-123";
const BASE = "https://llm.internal.example/v1/";
const T0 = Date.parse("2026-10-19T08:00:00Z");

afterEach(() => vi.restoreAllMocks());

function recorder(answer: () => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return answer();
  }) as unknown as typeof fetch;
  return { f, calls };
}
const ok = (message: unknown) => Response.json({ choices: [{ message }] });

describe("LLM client", () => {
  it("posts the model, messages and tools to {base}/chat/completions with the bearer key", async () => {
    const { f, calls } = recorder(() => ok({ role: "assistant", content: "Hi" }));
    const llm = createLlm({ baseUrl: BASE, apiKey: KEY, model: "m1", timeoutMs: 1000 }, f);
    const tools = [
      {
        type: "function" as const,
        function: { name: "t", description: "d", parameters: { type: "object" } },
      },
    ];
    const reply = await llm.complete([{ role: "user", content: "hello" }], tools);
    expect(reply).toEqual({ role: "assistant", content: "Hi" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://llm.internal.example/v1/chat/completions");
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.headers).toEqual({
      "content-type": "application/json",
      authorization: `Bearer ${KEY}`,
    });
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      model: "m1",
      messages: [{ role: "user", content: "hello" }],
      tools,
      tool_choice: "auto",
    });
  });

  it("sends no authorization header without a key, and no tools key without tools", async () => {
    const { f, calls } = recorder(() => ok({ role: "assistant", content: "Hi" }));
    await createLlm({ baseUrl: "http://x/v1", model: "m", timeoutMs: 1000 }, f).complete(
      [{ role: "user", content: "a" }],
      [],
    );
    expect(calls[0]?.init.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(String(calls[0]?.init.body))).not.toHaveProperty("tools");
  });

  it("reads tool calls with string or object arguments, and names a call without an id", async () => {
    const { f } = recorder(() =>
      ok({
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "a", type: "function", function: { name: "x", arguments: '{"n":1}' } },
          { type: "function", function: { name: "y", arguments: { n: 2 } } },
        ],
      }),
    );
    const r = await createLlm({ baseUrl: BASE, model: "m", timeoutMs: 1000 }, f).complete([], []);
    expect(r).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "a", type: "function", function: { name: "x", arguments: '{"n":1}' } },
        { id: "call_1", type: "function", function: { name: "y", arguments: '{"n":2}' } },
      ],
    });
  });

  const failure = async (f: typeof fetch, timeoutMs = 1000) => {
    const err = await createLlm({ baseUrl: BASE, apiKey: KEY, model: "m", timeoutMs }, f)
      .complete([{ role: "user", content: "a" }], [])
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmError);
    const text = String((err as Error).message);
    expect(text).not.toContain(KEY);
    expect(text).not.toContain("llm.internal.example");
    return err as LlmError;
  };

  it("an HTTP error names only the status, never the key, the URL or the body", async () => {
    const err = await failure(
      recorder(() => new Response(`bad key ${KEY} at ${BASE}`, { status: 401 })).f,
    );
    expect(err.kind).toBe("status");
    expect(err.message).toBe("The language model answered with an error (HTTP 401).");
  });

  it("a call that takes longer than the timeout stops with a timeout error", async () => {
    const hang = ((_url: string, init: RequestInit) =>
      new Promise((_, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      })) as unknown as typeof fetch;
    const started = Date.now();
    const err = await failure(hang, 50);
    expect(err.kind).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("a network failure and a broken answer give errors without the URL", async () => {
    const down = (() =>
      Promise.reject(new TypeError(`fetch failed: ${BASE}`))) as unknown as typeof fetch;
    expect((await failure(down)).kind).toBe("network");
    expect((await failure(recorder(() => new Response("not json")).f)).kind).toBe("format");
    expect((await failure(recorder(() => Response.json({ choices: [] })).f)).kind).toBe("format");
  });
});

// ------------------------------------------------------------------ the turn loop

function setup(script: (messages: LlmMessage[], n: number) => LlmMessage & { role: "assistant" }) {
  const db = openDb(":memory:");
  const now = () => T0;
  const user = ensureUser(db, "owner@example.com", "Owner", T0) as User;
  const writes: string[] = [];
  const preview = createPreview({
    db,
    sync: {
      runNow: async () => void writes.push("sync"),
      idle: async () => {},
      request: () => void writes.push("sync"),
    },
    mailer: {},
    live: { notify: () => {} },
    now,
    app: () => new Hono(),
    dry: () => null,
  } as unknown as PreviewDeps);
  const sent: { messages: LlmMessage[]; tools: string[] }[] = [];
  const llm: Llm = {
    model: "m",
    complete: async (messages, tools) => {
      sent.push({ messages: structuredClone(messages), tools: tools.map((t) => t.function.name) });
      return script(messages, sent.length);
    },
  };
  const chat = createChat({
    db,
    llm,
    tools: chatTools({ db, preview, baseUrl: "http://localhost:3000", now }),
    now,
  });
  return { db, user, chat, sent, writes };
}

const call = (name: string, args: unknown): LlmMessage & { role: "assistant" } => ({
  role: "assistant",
  content: null,
  tool_calls: [
    { id: `c-${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } },
  ],
});

describe("assistant chat turn", () => {
  it("runs a write tool as a staged change from assistant chat, sends the result back, and saves the turn", async () => {
    const { db, user, chat, sent, writes } = setup((_m, n) =>
      n === 1
        ? call("propose_create_event", {
            title: "Deep work",
            start: "2026-10-20T13:00:00+02:00",
            end: "2026-10-20T15:00:00+02:00",
          })
        : { role: "assistant", content: "Staged." },
    );
    const { conversationId } = await chat.send(user, null, "Book deep work", {});
    expect(sent).toHaveLength(2);
    expect(sent[0]?.tools).toContain("propose_create_event");
    expect(sent[0]?.tools).not.toContain("apply_staged_changes");
    const toolMsg = sent[1]?.messages.at(-1);
    expect(toolMsg).toMatchObject({ role: "tool", tool_call_id: "c-propose_create_event" });
    expect(JSON.parse((toolMsg as { content: string }).content)).toMatchObject({
      state: "pending",
    });
    expect(
      all(db, "SELECT source, kind, state FROM staged_changes WHERE user_id = ?", user.id),
    ).toEqual([{ source: "assistant_chat", kind: "event_create", state: "pending" }]);
    expect(writes).toEqual([]);
    expect(messagesOf(db, conversationId).map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(chat.items(user.id, conversationId)).toEqual([
      { kind: "user", text: "Book deep work" },
      expect.objectContaining({ kind: "proposal", state: "pending" }),
      { kind: "assistant", text: "Staged." },
    ]);
  });

  it("sends the stored conversation as context on the next turn", async () => {
    const { user, chat, sent } = setup((_m, n) => ({ role: "assistant", content: `answer ${n}` }));
    const { conversationId } = await chat.send(user, null, "first", {});
    await chat.send(user, conversationId, "second", { from: "2026-10-19", to: "2026-10-26" });
    const last = sent.at(-1)?.messages ?? [];
    expect(last.map((m) => [m.role, m.role === "system" ? "" : m.content])).toEqual([
      ["system", ""],
      ["user", "first"],
      ["assistant", "answer 1"],
      ["user", "second"],
    ]);
    expect(last[0]?.content).toContain("The planner shows the dates 2026-10-19 to 2026-10-26");
  });

  it("answers bad arguments and unknown tools with an error result, and stops after MAX_STEPS calls", async () => {
    const { db, user, chat, sent } = setup(() => ({
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "a", type: "function", function: { name: "nope", arguments: "{}" } },
        { id: "b", type: "function", function: { name: "list_events", arguments: "{oops" } },
      ],
    }));
    const { conversationId } = await chat.send(user, null, "loop", {});
    expect(sent).toHaveLength(MAX_STEPS);
    const results = sent[1]?.messages.filter((m) => m.role === "tool").map((m) => m.content);
    expect(results).toEqual([
      "Error: there is no tool nope.",
      "Error: the arguments are not valid JSON.",
    ]);
    expect(messagesOf(db, conversationId).at(-1)?.content).toContain("too many steps");
  });

  it("saves nothing of a turn whose model call fails, and the route logs no key", async () => {
    const { db, user, chat } = setup(() => {
      throw new LlmError("The language model answered with an error (HTTP 500).", "status");
    });
    await expect(chat.send(user, null, "hello", {})).rejects.toBeInstanceOf(LlmError);
    expect(all(db, "SELECT * FROM assistant_messages")).toEqual([]);

    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("user", user);
      await next();
    });
    app.route("/api", assistantRoutes(db, chat));
    const logged: string[] = [];
    for (const k of ["log", "error", "warn", "info"] as const)
      vi.spyOn(console, k).mockImplementation((...a: unknown[]) => void logged.push(a.join(" ")));
    const res = await app.request("/api/assistant/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: "llm_failed",
      message: "The language model answered with an error (HTTP 500).",
    });
    expect(logged.join("\n")).not.toContain(KEY);
    expect(all(db, "SELECT * FROM assistant_usage")).toEqual([]);
  });
});
