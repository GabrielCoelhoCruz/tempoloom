// The replan glide (docs/specs/ui-refresh.md MOT-40, MOT-44): when the events of
// the shown days change, moved cards glide from where they were, new cards grow
// in, and removed cards fade out as clones. It loads after the week's first draw.
import { easeInOut, easeOut, exitMs, fadeMs, motionOK, moveMs } from "./motion.ts";

/** A card's box before the change, by its `data-box-key`, and its element. */
export type Firsts = Map<string, { rect: DOMRect; el: HTMLElement }>;

/** Measures every card of the grid, with its running animation where it is now. */
export function measure(grid: HTMLElement): Firsts {
  const out: Firsts = new Map();
  for (const el of grid.querySelectorAll<HTMLElement>("[data-box-key]"))
    out.set(el.dataset.boxKey ?? "", { rect: el.getBoundingClientRect(), el });
  return out;
}

/** Animates each card from its box in `first` to its box now (after the new render). */
export function glide(grid: HTMLElement, first: Firsts): void {
  const ok = motionOK();
  const fade: KeyframeAnimationOptions = { duration: fadeMs(), easing: "ease" };
  const seen = new Set<string>();
  for (const el of grid.querySelectorAll<HTMLElement>("[data-box-key]")) {
    const key = el.dataset.boxKey ?? "";
    seen.add(key);
    // Cancel a glide in progress: `first` holds where it was; measure where it ends.
    for (const a of el.getAnimations()) a.cancel();
    const was = first.get(key)?.rect;
    if (!was) {
      el.animate(
        ok ? { opacity: [0, 1], transform: ["scale(0.97)", "none"] } : { opacity: [0, 1] },
        ok ? { duration: fadeMs(), easing: easeOut() } : fade,
      );
      continue;
    }
    const now = el.getBoundingClientRect();
    const dx = was.left - now.left;
    const dy = was.top - now.top;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
    el.animate(
      ok ? { transform: [`translate(${dx}px, ${dy}px)`, "none"] } : { opacity: [0, 1] },
      ok ? { duration: moveMs(), easing: easeInOut() } : fade,
    );
  }
  // Under reduced motion a removed card goes at once.
  if (!ok) return;
  for (const [key, { el }] of first) {
    if (seen.has(key)) continue;
    const clone = el.cloneNode(true) as HTMLElement;
    clone.classList.replace("ev", "ev-leaving");
    for (const a of ["data-box-key", "data-event-id", "title"]) clone.removeAttribute(a);
    clone.setAttribute("aria-hidden", "true");
    clone.inert = true;
    grid.append(clone);
    const remove = () => clone.remove();
    clone
      .animate({ opacity: [1, 0] }, { duration: exitMs(), easing: easeOut() })
      .finished.then(remove, remove);
    // MOT-12: a safety net if the animation never ends.
    setTimeout(remove, exitMs() + 50);
  }
}
