// A deterministic OpenAI-compatible chat completions server for the E2E suite
// (CI has no language model). It listens on 127.0.0.1:TEMPOLOOM_LLM_FAKE_PORT,
// keeps every request the app sent, and answers by matching the last user
// message to a scripted reply. A script is a list of steps: step n answers the
// request that has n assistant messages after that user message, so a script
// can call tools and then answer with what the tool results said. Tests read
// the recorded requests to check what the app sent (tools, system prompt,
// history), so they prove the app and not this fake.
import { createServer, type Server } from "node:http";

export interface ChatRequest {
  model: string;
  messages: {
    role: string;
    content: string | null;
    tool_calls?: { id: string; function: { name: string; arguments: string } }[];
    tool_call_id?: string;
  }[];
  tools?: { type: string; function: { name: string; description: string; parameters: object } }[];
  authorization: string | null;
}

export type Step = (
  | { content: string }
  | { tools: { name: string; arguments: Record<string, unknown> }[]; content?: string }
  | { status: number }
) & {
  /** Milliseconds before the answer, as a slow model. */
  delayMs?: number;
  /** The answer waits until this promise settles: the test decides when the model answers. */
  until?: Promise<unknown>;
};

type Script = { match: RegExp; steps: (Step | ((req: ChatRequest) => Step))[] };

export const lastUser = (req: ChatRequest) =>
  [...req.messages].reverse().find((m) => m.role === "user")?.content ?? "";

/** The tool results of the current turn (after the last user message), in order. */
export function toolResults(req: ChatRequest): { name: string; content: string }[] {
  const i = req.messages.map((m) => m.role).lastIndexOf("user");
  const names = new Map<string, string>();
  const out: { name: string; content: string }[] = [];
  for (const m of req.messages.slice(i + 1)) {
    for (const c of m.tool_calls ?? []) names.set(c.id, c.function.name);
    if (m.role === "tool")
      out.push({ name: names.get(m.tool_call_id ?? "") ?? "", content: m.content ?? "" });
  }
  return out;
}

/** The JSON result of the last call of a tool in this turn. */
export function toolJson<T>(req: ChatRequest, name: string): T {
  const r = toolResults(req).findLast((x) => x.name === name);
  if (!r) throw new Error(`no ${name} result in the request`);
  return JSON.parse(r.content) as T;
}

export interface FakeLlm {
  /** The base URL the app gets as TEMPOLOOM_LLM_BASE_URL. */
  url: string;
  requests: ChatRequest[];
  on(match: RegExp, steps: Script["steps"]): void;
  reset(): void;
  close(): Promise<void>;
}

export async function startFakeLlm(port: number): Promise<FakeLlm> {
  const requests: ChatRequest[] = [];
  let scripts: Script[] = [];
  let n = 0;
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (d: Buffer) => (body += d.toString()));
    req.on("end", () => {
      const send = (status: number, data: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(data));
      };
      if (req.method !== "POST" || req.url !== "/v1/chat/completions")
        return send(404, { error: { message: "not found" } });
      const parsed = { ...JSON.parse(body), authorization: req.headers.authorization ?? null };
      const chat = parsed as ChatRequest;
      requests.push(chat);
      const text = lastUser(chat);
      const script = scripts.find((s) => s.match.test(text));
      const i = chat.messages.map((m) => m.role).lastIndexOf("user");
      const index = chat.messages.slice(i + 1).filter((m) => m.role === "assistant").length;
      const raw = script?.steps[index];
      let step: Step;
      try {
        step = !raw
          ? { content: `fake-llm: no step ${index} for “${text}”` }
          : typeof raw === "function"
            ? raw(chat)
            : raw;
      } catch (err) {
        step = { content: `fake-llm: step failed: ${err instanceof Error ? err.message : err}` };
      }
      const answer = () => {
        if ("status" in step) return send(step.status, { error: { message: "scripted failure" } });
        const message =
          "tools" in step
            ? {
                role: "assistant",
                content: step.content ?? null,
                tool_calls: step.tools.map((t) => ({
                  id: `call_${++n}`,
                  type: "function",
                  function: { name: t.name, arguments: JSON.stringify(t.arguments) },
                })),
              }
            : { role: "assistant", content: step.content };
        send(200, {
          id: `chatcmpl-${n}`,
          object: "chat.completion",
          model: chat.model,
          choices: [
            { index: 0, message, finish_reason: "tool_calls" in message ? "tool_calls" : "stop" },
          ],
        });
      };
      if (step.until) void step.until.finally(answer);
      else if (step.delayMs) setTimeout(answer, step.delayMs);
      else answer();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    on: (match, steps) => scripts.push({ match, steps }),
    reset: () => {
      scripts = [];
      requests.length = 0;
    },
    close: () => new Promise((r) => server.close(() => r())),
  };
}
