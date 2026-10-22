// An edit form sends only the fields the user changed (automations-overview.md
// rule 11, decision "an edit sends only the fields it changed"): a change that
// another client saved after the form opened stays.
import { useState } from "preact/hooks";

/**
 * Keys that make one field: when one of them changed, all of them that the
 * body has are sent, so the server never takes half of it (the hours choice
 * and its item-specific ranges).
 */
const GROUPS: string[][] = [["hoursMode", "hoursSetId", "itemHours"]];

/** An invalid number of a form (NaN, Infinity) is always sent, so the server refuses it. */
const invalidNumber = (v: unknown) => typeof v === "number" && !Number.isFinite(v);

/** The fields of `next` whose value differs from the same field of `first`. */
export function changedFields<T extends object>(first: T, next: T): Partial<T> {
  const a = first as Record<string, unknown>;
  const b = next as Record<string, unknown>;
  const differs = (k: string) =>
    k in b && (invalidNumber(b[k]) || JSON.stringify(b[k]) !== JSON.stringify(a[k]));
  const keys = new Set(Object.keys(b).filter(differs));
  for (const group of GROUPS)
    if (group.some((k) => keys.has(k) || (k in a && !(k in b))))
      for (const k of group) if (k in b) keys.add(k);
  return Object.fromEntries(Object.entries(b).filter(([k]) => keys.has(k))) as Partial<T>;
}

/**
 * Keeps the body of an edit form as it was when the form appeared. Put
 * `ref(read)` on the `<form>`, where `read` reads the body of the form;
 * `changed` gives the fields of a body read later that differ. A new form
 * element (a form with a new key) reads its first body again.
 */
export function firstBody<T extends object>() {
  let first: { form: HTMLFormElement; body: T } | null = null;
  return {
    ref: (read: (form: HTMLFormElement) => T) => (form: HTMLFormElement | null) => {
      if (form && first?.form !== form) first = { form, body: read(form) };
    },
    changed: (form: HTMLFormElement, body: T): Partial<T> =>
      first?.form === form ? changedFields(first.body, body) : body,
  };
}

/** `firstBody` for the life of a component. */
export function useFirstBody<T extends object>() {
  return useState(() => firstBody<T>())[0];
}
