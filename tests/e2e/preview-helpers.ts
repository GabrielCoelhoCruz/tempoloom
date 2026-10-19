// Steps for preview mode and the MCP server: an MCP client over Streamable
// HTTP (JSON-RPC 2.0 over POST), and the planner's preview panel.
import type { APIRequestContext, Page } from "@playwright/test";
import { expect } from "./fixtures.ts";

export const iso = (t: number) => new Date(t).toISOString();

interface RpcReply {
  jsonrpc: "2.0";
  id?: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

export interface ToolResult {
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/** An MCP client that authenticates with a personal API key, as any MCP client can. */
export function mcpClient(request: APIRequestContext, key: string) {
  let id = 0;
  const headers = {
    authorization: `Bearer ${key}`,
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    "mcp-protocol-version": "2025-06-18",
  };
  const raw = async (method: string, params?: unknown): Promise<RpcReply> => {
    const res = await request.post("/mcp", {
      headers,
      data: { jsonrpc: "2.0", id: ++id, method, ...(params === undefined ? {} : { params }) },
    });
    expect(res.status(), `${method} status`).toBe(200);
    expect(res.headers()["content-type"]).toContain("application/json");
    const reply = (await res.json()) as RpcReply;
    expect(reply.jsonrpc).toBe("2.0");
    expect(reply.id).toBe(id);
    return reply;
  };
  const call = async (method: string, params?: unknown) => {
    const r = await raw(method, params);
    if (r.error) throw new Error(`${method}: ${r.error.message}`);
    return r.result as Record<string, unknown>;
  };
  return {
    raw,
    call,
    async notify(method: string): Promise<void> {
      const res = await request.post("/mcp", { headers, data: { jsonrpc: "2.0", method } });
      expect(res.status()).toBe(202);
    },
    /** Calls a tool; the full result, including tool errors. */
    async toolResult(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
      return (await call("tools/call", { name, arguments: args })) as unknown as ToolResult;
    },
    /** Calls a tool and returns its structured content; a tool error fails the test. */
    async tool<T = Record<string, unknown>>(
      name: string,
      args: Record<string, unknown> = {},
    ): Promise<T> {
      const r = (await call("tools/call", { name, arguments: args })) as unknown as ToolResult;
      if (r.isError) throw new Error(`${name}: ${r.content[0]?.text}`);
      expect(r.content[0]?.type).toBe("text");
      return r.structuredContent as T;
    },
    async toolNames(): Promise<string[]> {
      const r = (await call("tools/list")) as { tools: { name: string; inputSchema: object }[] };
      for (const t of r.tools) expect(t.inputSchema).toMatchObject({ type: "object" });
      return r.tools.map((t) => t.name);
    },
  };
}

export type Mcp = ReturnType<typeof mcpClient>;

/** Connects: initialize, then the initialized notification (MCP lifecycle). */
export async function connect(request: APIRequestContext, key: string): Promise<Mcp> {
  const mcp = mcpClient(request, key);
  const init = await mcp.call("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "tempoloom-e2e", version: "1.0.0" },
  });
  expect(init.protocolVersion).toBe("2025-06-18");
  expect(init.capabilities).toMatchObject({ tools: {} });
  expect(init.serverInfo).toMatchObject({ name: "tempoloom" });
  await mcp.notify("notifications/initialized");
  return mcp;
}

export const previewPanel = (p: Page) => p.getByTestId("preview-panel");
export const stagedRow = (p: Page, text: string) =>
  previewPanel(p).getByTestId("staged-change").filter({ hasText: text });

/** Opens the final list, removes the given items, confirms, and waits for the summary. */
export async function reviewAndApply(p: Page, remove: string[] = []): Promise<void> {
  await previewPanel(p).getByRole("button", { name: "Review and apply changes" }).click();
  const list = p.getByTestId("review-list");
  await expect(list).toBeVisible();
  for (const text of remove) {
    await list
      .getByTestId("review-item")
      .filter({ hasText: text })
      .getByRole("button", {
        name: "Remove",
      })
      .click();
    await expect(list.getByTestId("review-item").filter({ hasText: text })).toHaveCount(0);
  }
  await list.getByRole("button", { name: "Confirm and apply" }).click();
  await expect(p.getByTestId("apply-summary")).toBeVisible();
}
