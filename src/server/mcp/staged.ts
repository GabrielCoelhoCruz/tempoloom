// Staging a change in preview mode (docs/specs/assistant-preview-mode.md) for
// a tool: the MCP stage tools (src/server/mcp.ts, ./answers.ts) and the chat's
// library and review tools (src/server/assistant/) share it.
import { z } from "zod";
import { addDays, utcToLocal, weekdayOf } from "../../shared/time.ts";
import type { Db } from "../db.ts";
import { type Preview, type StageArgs, TargetBusy, zoneOf } from "../preview.ts";
import { type Caller, ToolError } from "./rpc.ts";

/** Staging refused because another open change of the target stays: a tool error the caller reads. */
export function busyAsToolError<T>(f: () => T): T {
  try {
    return f();
  } catch (err) {
    if (err instanceof TargetBusy) throw new ToolError(err.message);
    throw err;
  }
}

export const stagedOutput = z.object({
  id: z.string(),
  state: z.string(),
  summary: z.string(),
  review_url: z.string(),
  message: z.string(),
});

/** Monday of the week of an instant, for the planner link. */
function reviewUrl(baseUrl: string, zone: string, t: number): string {
  const d = utcToLocal(zone, t).date;
  return new URL(`/?week=${addDays(d, 1 - weekdayOf(d))}`, baseUrl).toString();
}

/**
 * Stages a change in preview mode for the caller and gives a stage tool's
 * result (stagedOutput). The MCP stage tools and the chat's library tools use
 * it; the chat's automation and policy tools stage through stageRequest
 * (src/server/assistant/review-tools.ts), whose result adds the calendar impact.
 */
export function stagedResult(
  deps: { db: Db; preview: Preview; baseUrl: string },
  caller: Caller,
  input: StageArgs,
  at: number,
) {
  const s = busyAsToolError(() =>
    deps.preview.stage(caller.user.id, {
      ...input,
      source: caller.source ?? "mcp_client",
      client: caller.client,
      unattended: caller.unattended === true,
    }),
  );
  return {
    id: s.id,
    state: s.state,
    summary: s.summary,
    review_url: reviewUrl(deps.baseUrl, zoneOf(deps.db, caller.user.id), at),
    message:
      "The change is staged in Tempoloom's preview mode. Nothing is written until the user applies it.",
  };
}
