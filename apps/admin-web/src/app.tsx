import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { ApiError, browserFetch } from './api/client';
import { SessionProvider } from './auth/context';
import { SessionStore } from './auth/session';
import { LocaleProvider } from './i18n/locale';
import { keepShopData, restoreKept, startAsTheBrowserIs } from './offline/kept-data';
import { AppNotices } from './offline/notices';
import { createAdminRouter } from './router';

/** Whether a failed query is worth trying again: not when the API refused it for a reason. */
function retry(failures: number, error: unknown): boolean {
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
  if (error instanceof ApiError && error.code === 'BAD_USER_INPUT') return false;
  return failures < 2;
}

/**
 * The admin: its session, its language, the API's answers it keeps (and keeps for offline), and
 * its screens.
 */
export function App() {
  const [session] = useState(() => new SessionStore(browserFetch));
  const [queryClient] = useState(() => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry, staleTime: 15_000, refetchOnWindowFocus: true } },
    });
    // What the session last saw, for the pages to show offline (ADR-514).
    startAsTheBrowserIs();
    try {
      restoreKept(client, session.sessionId(), window.localStorage);
    } catch {
      // No storage to restore from.
    }
    return client;
  });
  useEffect(() => keepShopData(queryClient, session), [queryClient, session]);
  const [router] = useState(() => createAdminRouter(session));
  return (
    <LocaleProvider>
      <AppNotices />
      <SessionProvider store={session}>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </SessionProvider>
    </LocaleProvider>
  );
}
