// A field that saves when the user leaves it (the change event). Until that
// save ends it shows what the user typed: a page that draws again first, for
// example when a live update reads the account again (lib/live.ts), must not
// put the stored value back, or the change event never fires.
import type { TargetedEvent } from "preact";
import { useState } from "preact/hooks";

/**
 * The value and handlers of an `<input>` that shows `value` and calls
 * `onCommit` with the typed value on change; spread them on the input. The
 * field shows the stored value again when the save ends.
 */
export function useCommit(value: string | number, onCommit: (value: string) => unknown) {
  const [draft, setDraft] = useState<string | null>(null);
  return {
    value: draft ?? String(value),
    onInput: (e: TargetedEvent<HTMLInputElement>) => setDraft(e.currentTarget.value),
    onChange: (e: TargetedEvent<HTMLInputElement>) => {
      const typed = e.currentTarget.value;
      void Promise.resolve(onCommit(typed)).finally(() =>
        setDraft((d) => (d === typed ? null : d)),
      );
    },
  };
}
