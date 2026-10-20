import { useEffect, useState } from 'react';

/** `value`, once it has stayed the same for `ms`: for asking the core as someone stops typing. */
export function useDebounced<T>(value: T, ms = 500): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), ms);
    return () => window.clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}
