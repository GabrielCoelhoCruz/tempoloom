// Save state of a settings form, and the message of a failed request.
import { useState } from "preact/hooks";
import { ApiError } from "./api.ts";

export const messageOf = (err: unknown) =>
  err instanceof ApiError
    ? ((err.body as { message?: string } | undefined)?.message ?? `Error ${err.status}`)
    : String(err);

/** A new save clears the last "Saved" at once, so it is never mistaken for the new one. */
export function useSave() {
  const [state, setState] = useState<"idle" | "saved" | { error: string }>("idle");
  const save = async (fn: () => Promise<unknown>) => {
    setState("idle");
    try {
      await fn();
      setState("saved");
    } catch (err) {
      setState({ error: messageOf(err) });
    }
  };
  return { state, save, reset: () => setState("idle") };
}
