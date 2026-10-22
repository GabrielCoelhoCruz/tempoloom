// An edit form sends only the fields the user changed (automations-overview.md
// rule 11, decision "an edit sends only the fields it changed"): a change that
// another client saved after the form opened stays.
import { useRef } from "preact/hooks";

/** The fields of `next` whose value differs from the same field of `first`. */
export function changedFields<T extends object>(first: T, next: T): Partial<T> {
  const a = first as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(next).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(a[k])),
  ) as Partial<T>;
}

/**
 * Keeps the body of an edit form as it was when the form appeared. Put
 * `ref(read)` on the `<form>`, where `read` reads the body of the form;
 * `changed` gives the fields of a body read later that differ. A new form
 * element (a form with a new key) reads its first body again.
 */
export function useFirstBody<T extends object>() {
  const first = useRef<{ form: HTMLFormElement; body: T } | null>(null);
  return {
    ref: (read: (form: HTMLFormElement) => T) => (form: HTMLFormElement | null) => {
      if (form && first.current?.form !== form) first.current = { form, body: read(form) };
    },
    changed: (form: HTMLFormElement, body: T): Partial<T> =>
      first.current?.form === form ? changedFields(first.current.body, body) : body,
  };
}
