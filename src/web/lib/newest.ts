import { useCallback, useRef } from "preact/hooks";

/**
 * Loads of one view can read different URLs (another filter, another week), so
 * their answers can come out of order: api() orders the answers of one URL
 * only. Call the result when a load starts; the function it gives tells if
 * that load is still the newest one. Only the newest load may draw.
 */
export function useNewest(): () => () => boolean {
  const started = useRef(0);
  return useCallback(() => {
    const n = ++started.current;
    return () => n === started.current;
  }, []);
}
