import { type ReadonlySignal, signal } from "@preact/signals";

/** A signal that follows a media query on the viewport width (docs/specs/ui-refresh.md 5.7). */
function media(query: string): ReadonlySignal<boolean> {
  const list = matchMedia(query);
  const s = signal(list.matches);
  list.addEventListener("change", (e) => {
    s.value = e.matches;
  });
  return s;
}

/** LAY-40: an overlap cluster shows 3 columns from 1440 px, else 2. */
export const wide = media("(min-width: 1440px)");
