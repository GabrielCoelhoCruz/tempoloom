// A client for an OpenAI-compatible chat completions endpoint (assistant chat,
// docs/specs/assistant-chat.md). The operator points TEMPOLOOM_LLM_BASE_URL at
// any server that speaks POST {base}/chat/completions with function calling.
// No vendor SDK: one fetch per call. The API key and the base URL never go
// into an error text or a log line.

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type LlmMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface LlmTool {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface LlmConfig {
  baseUrl: string;
  apiKey?: string | undefined;
  model: string;
  /** Milliseconds one call may take. */
  timeoutMs: number;
}

/** A failure the user may see: the text names no URL and no key. */
export class LlmError extends Error {
  readonly kind: "timeout" | "network" | "status" | "format" | "stopped";
  constructor(message: string, kind: LlmError["kind"]) {
    super(message);
    this.kind = kind;
  }
}

export interface Llm {
  model: string;
  /** `signal` stops the call (the turn's deadline, or the client left); its reason, an LlmError, is thrown. */
  complete(
    messages: LlmMessage[],
    tools: LlmTool[],
    signal?: AbortSignal,
  ): Promise<LlmMessage & { role: "assistant" }>;
}

/** The text of a content field: a string, or the text parts of an array of content parts. */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p) =>
      typeof p === "string"
        ? p
        : typeof (p as { text?: unknown })?.text === "string"
          ? (p as { text: string }).text
          : "",
    )
    .join("");
}

/** The error a stopped call throws: the signal's reason when it is an LlmError. */
const stopped = (signal: AbortSignal) =>
  signal.reason instanceof LlmError
    ? signal.reason
    : new LlmError("The request was stopped.", "stopped");

export function createLlm(config: LlmConfig, fetchImpl: typeof fetch = fetch): Llm {
  const url = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  return {
    model: config.model,
    async complete(messages, tools, signal) {
      if (signal?.aborted) throw stopped(signal);
      const timeout = AbortSignal.timeout(config.timeoutMs);
      const abort = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const failed = (fallback: LlmError) =>
        signal?.aborted
          ? stopped(signal)
          : timeout.aborted
            ? new LlmError("The language model did not answer in time.", "timeout")
            : fallback;
      let res: Response;
      try {
        res = await fetchImpl(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
          },
          body: JSON.stringify({
            model: config.model,
            messages,
            ...(tools.length ? { tools, tool_choice: "auto" } : {}),
          }),
          signal: abort,
        });
      } catch {
        throw failed(new LlmError("The language model cannot be reached.", "network"));
      }
      if (!res.ok) {
        // The body may echo the request; only the status goes into the text.
        await res.body?.cancel();
        throw new LlmError(
          `The language model answered with an error (HTTP ${res.status}).`,
          "status",
        );
      }
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        throw failed(new LlmError("The language model sent an answer that is not JSON.", "format"));
      }
      const message = (body as { choices?: { message?: unknown }[] })?.choices?.[0]?.message;
      if (!message || typeof message !== "object")
        throw new LlmError("The language model sent an answer without a message.", "format");
      const m = message as { content?: unknown; tool_calls?: unknown };
      const calls = Array.isArray(m.tool_calls) ? m.tool_calls : [];
      const toolCalls: ToolCall[] = [];
      for (const [i, c] of calls.entries()) {
        const fn = (c as { function?: { name?: unknown; arguments?: unknown } })?.function;
        if (typeof fn?.name !== "string")
          throw new LlmError("The language model sent a tool call without a name.", "format");
        const args = fn.arguments;
        toolCalls.push({
          id:
            typeof (c as { id?: unknown }).id === "string" ? (c as { id: string }).id : `call_${i}`,
          type: "function",
          function: {
            name: fn.name,
            arguments:
              typeof args === "string" ? args : args === undefined ? "{}" : JSON.stringify(args),
          },
        });
      }
      const text = contentText(m.content);
      if (!text.trim() && toolCalls.length === 0)
        throw new LlmError("The language model sent an empty answer.", "format");
      return {
        role: "assistant",
        content: text || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      };
    },
  };
}
