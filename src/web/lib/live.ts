// Live updates (accounts-delegated-access.md rule 9): the server signals each
// change to the account, and the open view reads its data again.
import { signal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import { CLIENT_ID } from "./api.ts";

const changes = signal(0);
let source: EventSource | undefined;

/**
 * Opens the change stream of this page, once. `mark` is the account's change
 * mark from the data the page loaded first; the stream starts with the current
 * mark, so the page reads again only when it missed a change (before the
 * stream connected, or while it reconnected).
 */
export function startLive(mark: string | undefined, onChange: () => void): void {
  if (source) return;
  let seen = mark;
  const read = (e: MessageEvent<string>) => {
    if (e.data === seen) return;
    seen = e.data;
    changes.value++;
    onChange();
  };
  source = new EventSource(`/api/live?client=${CLIENT_ID}`);
  source.addEventListener("ready", read);
  source.addEventListener("change", read);
}

/** Calls `load` again after each change to the account by another page or the planner. */
export function useLive(load: () => unknown): void {
  useEffect(() => {
    let first = true;
    return changes.subscribe(() => {
      if (first) first = false;
      else void load();
    });
  }, [load]);
}
