import { useCallback, useEffect, useRef } from "preact/hooks";

/**
 * Loads of one view can read different URLs (another filter, another week), so
 * their answers can come out of order: api() orders the answers of one URL
 * only. Call the result when a load starts; the function it gives tells if
 * that load is still the newest one. Only the newest load may draw, and no
 * load draws after the component is gone (some loads write shared signals).
 */
export function useNewest(): () => () => boolean {
  const started = useRef(0);
  useEffect(
    () => () => {
      started.current++;
    },
    [],
  );
  return useCallback(() => {
    const n = ++started.current;
    return () => n === started.current;
  }, []);
}
