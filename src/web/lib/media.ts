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
/** LAY-60: the right column is a drawer at 1180 px and below. */
export const narrow = media("(max-width: 1180px)");
/** LAY-62: three days at 860 px and below. */
export const threeDays = media("(max-width: 860px)");
/** LAY-63: one day at 640 px and below. */
export const oneDay = media("(max-width: 640px)");
