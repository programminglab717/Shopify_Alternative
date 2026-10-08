import { useSyncExternalStore } from 'react';

const WIDE = '(min-width: 768px)';

function subscribe(onChange: () => void) {
  if (typeof window.matchMedia !== 'function') return () => {};
  const query = window.matchMedia(WIDE);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

/**
 * Whether the screen is as wide as a tablet's, Tailwind's `md`: for a section a phone shows in
 * another place, rendered once where it belongs rather than twice with one hidden.
 */
export function useWide(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => typeof window.matchMedia === 'function' && window.matchMedia(WIDE).matches,
    () => false,
  );
}
