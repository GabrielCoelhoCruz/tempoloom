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
      if (View) return;
      void load().then((v) => {
        View = v;
        setLoaded(true);
      });
    }, []);
    return View ? createElement(View, props) : null;
  };
}
