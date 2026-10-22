// A field that saves when the user leaves it (the change event). Until that
// save ends it shows what the user typed: a page that draws again first, for
// example when a live update reads the account again (lib/live.ts), must not
// put the stored value back, or the change event never fires.
import type { TargetedEvent } from "preact";
import { useState } from "preact/hooks";

/**
 * The value and handlers of an `<input>` that shows `value` and calls
 * `onCommit` with the typed value on change; spread them on the input. The
 * field shows the stored value again when the save ends, and at once when the
 * user types the stored value again, so it follows changes from other clients.
 */
export function useCommit(
  value: string | number,
  // biome-ignore lint/suspicious/noConfusingVoidType: a commit may also save nothing.
  onCommit: (value: string) => Promise<unknown> | void,
) {
  const [draft, setDraft] = useState<string | null>(null);
  return {
    value: draft ?? String(value),
    onInput: (e: TargetedEvent<HTMLInputElement>) => {
      const typed = e.currentTarget.value;
      setDraft(typed === String(value) ? null : typed);
    },
    onChange: (e: TargetedEvent<HTMLInputElement>) => {
      const typed = e.currentTarget.value;
      // The callers show their own error; a failed save only ends the draft.
      void Promise.resolve()
        .then(() => onCommit(typed))
        .catch(() => {})
        .finally(() => setDraft((d) => (d === typed ? null : d)));
    },
  };
}

/**
 * The same for a checkbox that saves on change: until its save ends it shows
 * the value the user clicked, also when the page draws again with the stored
 * value meanwhile. Saves run one after the other, so a fast second click
 * saves the value it shows and that save ends last.
 */
export function useCommitCheck(value: boolean, onCommit: (checked: boolean) => Promise<unknown>) {
  const [draft, setDraft] = useState<boolean | null>(null);
  const [queue] = useState(() => ({ last: Promise.resolve() as Promise<unknown> }));
  return {
    checked: draft ?? value,
    onChange: (e: TargetedEvent<HTMLInputElement>) => {
      const checked = e.currentTarget.checked;
      setDraft(checked);
      queue.last = queue.last
        .then(() => onCommit(checked))
        .catch(() => {})
        .finally(() => setDraft((d) => (d === checked ? null : d)));
    },
  };
}
