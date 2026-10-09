import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { useState } from 'react';
import { ApiError, browserFetch } from './api/client';
import { SessionProvider } from './auth/context';
import { SessionStore } from './auth/session';
import { LocaleProvider } from './i18n/locale';
import { AppNotices } from './offline/notices';
import { createAdminRouter } from './router';

/** Whether a failed query is worth trying again: not when the API refused it for a reason. */
function retry(failures: number, error: unknown): boolean {
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
  if (error instanceof ApiError && error.code === 'BAD_USER_INPUT') return false;
  return failures < 2;
}

/** The admin: its session, its language, the API's answers it keeps, and its screens. */
export function App() {
  const [session] = useState(() => new SessionStore(browserFetch));
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry, staleTime: 15_000, refetchOnWindowFocus: true } },
      }),
  );
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
