// The tools of assistant chat (docs/specs/assistant-chat.md). The chat uses the
// MCP server's read and propose tools (src/server/mcp.ts), so a chat proposal
// and an MCP proposal are staged by the same code in preview mode
// (assistant-preview-mode.md). The chat never applies: the user applies in the
// planner (rule 12), so apply_staged_changes is not a chat tool.
//
// To give the chat a new ability, add a Tool to chatTools here and, when the
// model needs to know when to use it, a line in the system prompt
// (src/server/assistant/prompt.ts). A tool that changes the calendar, an
// automation or a task must only stage the change (effect "stage").
import { z } from "zod";
import type { Db } from "../db.ts";
import type { LlmTool } from "../llm.ts";
import { jsonSchema, type Tool, tool } from "../mcp/rpc.ts";
import { type McpDeps, mcpTools } from "../mcp.ts";
import { addMemory } from "./store.ts";

export type ChatToolDeps = Omit<McpDeps, "writeEnabled">;

/** Rules 22, 25: "remember ..." stores a chat memory. It changes no calendar. */
function memoryTools(db: Db, now: () => number): Tool[] {
  return [
    tool({
      name: "save_memory",
      effect: "store",
      title: "Remember a preference",
      description:
        "Stores a preference the user asked you to remember, in the user's words. Memories shape your suggestions only; they never make a change on their own. Name people by name or email.",
      input: z.object({
        text: z.string().trim().min(1).max(500),
        people: z
          .array(z.string().trim().min(1).max(200))
          .max(20)
          .optional()
          .describe("Names or emails of people that the memory is about"),
      }),
      output: z.object({ id: z.string(), text: z.string(), message: z.string() }),
      run: ({ user }, a) => {
        const m = addMemory(db, user.id, a.text, a.people ?? [], now());
        return {
          id: m.id,
          text: m.text,
          message: "Saved. The user can read and delete it in the memory list.",
        };
      },
    }),
  ];
}

/** Every tool of the chat. */
export function chatTools(deps: ChatToolDeps): Tool[] {
  return [...mcpTools(deps).filter((t) => t.effect !== "apply"), ...memoryTools(deps.db, deps.now)];
}

/** A tool in the format of the chat completions API ("tools", function calling). */
export const llmTool = (t: Tool): LlmTool => ({
  type: "function",
  function: { name: t.name, description: t.description, parameters: jsonSchema(t.input, "input") },
});
