import { useEffect, useState } from "react";

/**
 * Returns `value` after it has been stable for `delay` ms. Useful for binding
 * fast-typing inputs to slower side-effects (URL updates, network calls).
 */
export function useDebouncedValue<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(id);
  }, [value, delay]);
  return debounced;
}
