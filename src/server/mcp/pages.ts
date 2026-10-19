// Pages of the MCP list tools (docs/specs/assistant-mcp-server.md).
import { z } from "zod";
import { ToolError } from "./rpc.ts";

export const PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

export const pageInput = {
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_SIZE)
    .optional()
    .describe(`Rows per page. Default ${PAGE_SIZE}, at most ${MAX_PAGE_SIZE}`),
  cursor: z.string().optional().describe("next_cursor from the previous page"),
};
export const nextCursor = z
  .string()
  .optional()
  .describe("Only when more rows exist: pass it as cursor to get the next page");

/**
 * Keyset pages: the cursor holds the sort key of the last row, so a row added
 * between two calls never repeats or shifts a row (an offset would). It also
 * holds the tool and its filter, so a cursor of another list is refused.
 * Opaque to clients: base64url JSON.
 */
export function cursorKey<K>(
  tool: string,
  filter: string,
  keySchema: z.ZodType<K>,
  cursor: string | undefined,
): K | undefined {
  if (cursor === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {}
  const c = z.object({ t: z.literal(tool), f: z.literal(filter), k: keySchema }).safeParse(parsed);
  if (!c.success)
    throw new ToolError(`Invalid cursor: pass next_cursor from the previous ${tool} page`);
  return c.data.k;
}

/** Cuts the extra row that a query of limit + 1 rows returns, and names the next page. */
export function cut<T>(
  rows: T[],
  limit: number,
  tool: string,
  filter: string,
  key: (row: T) => unknown,
): { rows: T[]; next_cursor?: string } {
  if (rows.length <= limit) return { rows };
  const page = rows.slice(0, limit);
  const k = key(page[limit - 1] as T);
  return { rows: page, next_cursor: cursorOf(tool, filter, k) };
}

/** The cursor of the page after the row with the sort key k. */
export const cursorOf = (tool: string, filter: string, k: unknown) =>
  Buffer.from(JSON.stringify({ t: tool, f: filter, k })).toString("base64url");
