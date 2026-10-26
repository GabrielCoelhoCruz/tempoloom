// The client of the OpenAI-compatible endpoint (src/server/llm.ts). The turn
// loop of assistant chat has its own tests (assistant-chat.test.ts).
//
// Ways it can fail:
// 1. The request goes to the wrong path, without the bearer key, or without
//    the tools in the function calling format.
// 2. A tool call with object arguments, or without an id, is lost.
// 3. An error, a timeout or a broken answer hangs, or its text (shown to the
//    user and logged) holds the key or the base URL.
// 4. Content as an array of parts is lost, or an empty answer counts as one.
// 5. A stopped call (turn deadline, client left) keeps running, or loses its reason.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLlm, LlmError } from "../../src/server/llm.ts";

const KEY = "sk-secret-key-123";
const BASE = "https://llm.internal.example/v1/";

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

  it("joins the text parts of array content, and refuses an empty answer", async () => {
    const llm = (message: unknown) =>
      createLlm({ baseUrl: BASE, model: "m", timeoutMs: 1000 }, recorder(() => ok(message)).f);
    expect(
      await llm({
        role: "assistant",
        content: [
          { type: "text", text: "Hello " },
          { type: "image_url", image_url: {} },
          { type: "text", text: "there" },
        ],
      }).complete([], []),
    ).toEqual({ role: "assistant", content: "Hello there" });
    for (const content of [null, "", "  ", []]) {
      const err = await llm({ role: "assistant", content })
        .complete([], [])
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LlmError);
      expect((err as LlmError).message).toBe("The language model sent an empty answer.");
    }
  });

  it("a stopped signal ends the call at once with the signal's reason", async () => {
    const hang = ((_url: string, init: RequestInit) =>
      new Promise((_, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      })) as unknown as typeof fetch;
    const stop = new AbortController();
    const reason = new LlmError("The assistant did not finish in time.", "timeout");
    setTimeout(() => stop.abort(reason), 20);
    const llm = createLlm({ baseUrl: BASE, model: "m", timeoutMs: 10_000 }, hang);
    expect(await llm.complete([], [], stop.signal).catch((e: unknown) => e)).toBe(reason);
    const other = new AbortController();
    other.abort();
    const err = await llm.complete([], [], other.signal).catch((e: unknown) => e);
    expect((err as LlmError).kind).toBe("stopped");
  });
});
