// Live updates (accounts-delegated-access.md rule 9): the server signals each
// change to the account, and the open view reads its data again.
import { signal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import { CLIENT_ID } from "./api.ts";

const changes = signal(0);
let source: EventSource | undefined;

/** Opens the change stream of this page, once. */
export function startLive(onChange: () => void): void {
  if (source) return;
  source = new EventSource(`/api/live?client=${CLIENT_ID}`);
  source.addEventListener("change", () => {
    changes.value++;
    onChange();
  });
  // The stream opens after the page's first load and reopens after a drop; a
  // change made before it (re)connected sent no signal, so the views read again.
  source.addEventListener("ready", () => {
    changes.value++;
  });
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
