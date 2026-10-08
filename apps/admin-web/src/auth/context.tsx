import { useQuery } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import type { Me, SessionSnapshot, SessionStore } from './session';

const SessionContext = createContext<SessionStore | null>(null);

/** The session for the admin's screens, kept in step with the admin's other tabs. */
export function SessionProvider({ store, children }: { store: SessionStore; children: ReactNode }) {
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === 'hatti.session') store.sync();
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [store]);
  return <SessionContext.Provider value={store}>{children}</SessionContext.Provider>;
}

export function useSessionStore(): SessionStore {
  const store = useContext(SessionContext);
  if (!store) throw new Error('useSessionStore must be used inside <SessionProvider>');
  return store;
}

export function useSession(): SessionSnapshot {
  const store = useSessionStore();
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}

/** The query key of the account and its shops, invalidated when a shop is opened. */
export const ME_KEY = ['me'] as const;

/** The account, its session and the shops it works in (`GET /auth/me`). */
export function useMe() {
  const store = useSessionStore();
  const { signedIn } = useSession();
  return useQuery({
    queryKey: ME_KEY,
    queryFn: () => store.auth<Me>('/auth/me'),
    enabled: signedIn,
    staleTime: 60_000,
  });
}
