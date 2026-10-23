import { signal } from "@preact/signals";
import type { FunctionComponent } from "preact";
import { createElement } from "preact";
import { useEffect, useState } from "preact/hooks";

/**
 * A page or part of a page in its own chunk, loaded on first render, so the
 * planner's cold load stays small.
 */
export function lazyComponent<P extends object>(
  load: () => Promise<FunctionComponent<P>>,
): FunctionComponent<P> {
  let View: FunctionComponent<P> | undefined;
  return (props: P) => {
    const [, setLoaded] = useState(false);
    useEffect(() => {
      // Another instance may have loaded the code after this one drew nothing.
      if (View) {
        setLoaded(true);
        return;
      }
      void load().then((v) => {
        View = v;
        setLoaded(true);
      });
    }, []);
    return View ? createElement(View, props) : null;
  };
}

/**
 * True once the first page has drawn its main data and the browser is idle.
 * Secondary parts (planner panels, alerts, banners) render from then on, so
 * their code and requests never compete with the planner's cold load
 * (docs/performance.md).
 */
export const settled = signal(false);
let settling = false;

/** The first page has drawn its main data; `settled` follows when the browser is idle. */
export function settle(): void {
  if (settling) return;
  settling = true;
  const done = () => {
    settled.value = true;
  };
  // A short wait first, so the page's own first draw is painted before the
  // parts' code and requests start.
  setTimeout(() => {
    if (typeof requestIdleCallback === "function") requestIdleCallback(done, { timeout: 300 });
    else done();
  }, 50);
}
