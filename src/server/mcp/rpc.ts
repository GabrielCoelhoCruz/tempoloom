// JSON-RPC 2.0 messages of the MCP server (docs/specs/assistant-mcp-server.md):
// initialize, ping, tools/list and tools/call.
import { z } from "zod";
import type { User } from "../accounts.ts";
import type { Source } from "../preview.ts";

/** Protocol versions this server speaks, newest first. */
export const PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

export interface Caller {
  user: User;
  /** The API key's name: the label of this connection in preview mode. */
  client: string;
  /** Who stages the changes in preview mode; default mcp_client. */
  source?: Source;
}

/** An error the caller can fix: its message is the tool result. */
export class ToolError extends Error {}

/** read: no change; stage: stages a change, no calendar write; apply: writes staged changes, deletes too. */
export type Effect = "read" | "stage" | "apply";

export interface Tool {
  name: string;
  title: string;
  description: string;
  input: z.ZodObject;
  output: z.ZodObject;
  effect: Effect;
  run: (caller: Caller, args: never) => unknown;
}

/**
 * A tool with typed arguments and result, stored as a Tool. run may return
 * z.input of the output schema: tools/call parses it.
 */
export const tool = <S extends z.ZodObject, O extends z.ZodObject>(t: {
  name: string;
  title: string;
  description: string;
  input: S;
  output: O;
  effect: Effect;
  run: (caller: Caller, args: z.infer<S>) => z.input<O> | Promise<z.input<O>>;
}): Tool => t as unknown as Tool;

/**
 * JSON Schema 2020-12, the MCP default, so without a $schema key. An input
 * schema accepts what parses (unknown keys are dropped); an output schema
 * describes what parse returns (no other keys).
 */
export const jsonSchema = (schema: z.ZodObject, io: "input" | "output") => {
  const { $schema: _, ...rest } = z.toJSONSchema(schema, { io }) as Record<string, unknown>;
  return rest;
};

export interface Message {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

const reply = (id: unknown, result: unknown) => ({ jsonrpc: "2.0", id, result });
export const fail = (id: unknown, code: number, message: string) => ({
  jsonrpc: "2.0",
  id,
  error: { code, message },
});

/** The result of a tool that failed on the server, by its effect. */
const FAILED: Record<Effect, string> = {
  read: "The tool failed on the server",
  stage:
    "The tool failed on the server, and the change may have been staged. Call list_staged_changes to check before you try again.",
  apply:
    "The tool failed on the server, and some changes may have been applied. Call list_staged_changes to see which are still open, and list_events to check the calendar, before you try again.",
};

export type CallResult =
  | { isError: true; text: string }
  | { isError: false; text: string; data: Record<string, unknown> };

/**
 * Runs one tool with raw arguments: the MCP server's tools/call and assistant
 * chat both call tools through here. Bad arguments and a ToolError give an
 * error text for the caller; another failure says what to check (FAILED).
 */
export async function callTool(
  t: Tool,
  caller: Caller,
  raw: unknown,
  failedText: string = FAILED[t.effect],
): Promise<CallResult> {
  const args = t.input.safeParse(raw ?? {});
  if (!args.success) {
    const issues = args.error.issues.map((i) => `${i.path.join(".") || "arguments"}: ${i.message}`);
    return { isError: true, text: issues.join("; ") };
  }
  // A server failure after a write tool ran may come after its change was
  // staged or applied: say so, so the client checks before it tries again.
  const failed = { isError: true, text: failedText } as const;
  try {
    // The result must match the outputSchema that tools/list gave: parse
    // drops other keys, and a wrong type is a server failure, not a result.
    const out = t.output.safeParse(await t.run(caller, args.data as never));
    if (!out.success) {
      console.error(`Tool ${t.name} returned a result outside its outputSchema`, out.error);
      return failed;
    }
    const data = out.data as Record<string, unknown>;
    return { isError: false, text: JSON.stringify(data), data };
  } catch (err) {
    if (!(err instanceof ToolError)) {
      console.error(`Tool ${t.name} failed`, err);
      return failed;
    }
    return { isError: true, text: err.message };
  }
}

/** Answers one JSON-RPC message with the given tools; null for a notification or a response. */
export function rpcHandler(tools: Tool[], writeEnabled: boolean) {
  const visible = () => tools.filter((t) => writeEnabled || t.effect === "read");

  async function handle(caller: Caller, m: Message): Promise<object | null> {
    const isRequest = m.id !== undefined && m.id !== null;
    if (m.jsonrpc !== "2.0" || typeof m.method !== "string") {
      // A response from the client, or a malformed message.
      if (m.jsonrpc === "2.0" && m.method === undefined && ("result" in m || "error" in m))
        return null;
      return fail(m.id ?? null, -32600, "Invalid request");
    }
    if (!isRequest) return null; // A notification: nothing to answer.
    const params = (m.params ?? {}) as Record<string, unknown>;
    switch (m.method) {
      case "initialize": {
        const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
        return reply(m.id, {
          protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "tempoloom", title: "Tempoloom", version: "0.1.0" },
          instructions: writeEnabled
            ? "Read the user's calendar with the read tools. Write tools only stage changes in Tempoloom's preview mode; the user applies them."
            : "This server gives AI tools read-only access: read tools only.",
        });
      }
      case "ping":
        return reply(m.id, {});
      case "tools/list":
        return reply(m.id, {
          tools: visible().map((t) => {
            return {
              name: t.name,
              title: t.title,
              description: t.description,
              inputSchema: jsonSchema(t.input, "input"),
              outputSchema: jsonSchema(t.output, "output"),
              // Staging writes nothing to the calendar; applying runs staged deletes.
              annotations: {
                readOnlyHint: t.effect === "read",
                destructiveHint: t.effect === "apply",
                idempotentHint: t.effect === "read",
                openWorldHint: false,
              },
            };
          }),
        });
      case "tools/call": {
        const name = typeof params.name === "string" ? params.name : "";
        const t = tools.find((x) => x.name === name);
        if (!t) return fail(m.id, -32602, `Unknown tool: ${name}`);
        if (t.effect !== "read" && !writeEnabled)
          return fail(
            m.id,
            -32602,
            `${name} is not available: this server gives AI tools read-only access`,
          );
        const r = await callTool(t, caller, params.arguments);
        return reply(m.id, {
          content: [{ type: "text", text: r.text }],
          ...(r.isError ? { isError: true } : { structuredContent: r.data }),
        });
      }
      default:
        return fail(m.id, -32601, `Method not found: ${m.method}`);
    }
  }

  return handle;
}
