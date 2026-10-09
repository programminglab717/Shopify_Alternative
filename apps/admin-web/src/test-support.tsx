import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { vi } from 'vitest';
import { browserFetch } from './api/client';
import { SessionProvider } from './auth/context';
import { SessionStore } from './auth/session';
import type { StaffRole } from './auth/session';
import { LocaleProvider } from './i18n/locale';
import { createAdminRouter } from './router';

// What the admin's screen tests share: a member signed in to `shop_1`, a fake core answering
// each GraphQL operation by its name, and the admin rendered at a path.

export const LATER = new Date(Date.now() + 3_600_000).toISOString();

/** A session kept as a reload finds it: signed in, the second step proved. */
export function signedIn(): void {
  window.localStorage.setItem(
    'hatti.session',
    JSON.stringify({
      accessToken: 'hsa_1',
      accessTokenExpiresAt: LATER,
      refreshToken: 'hsr_1',
      refreshTokenExpiresAt: LATER,
      session: { id: 'ses_1', mfaVerified: true, authenticatedAt: new Date().toISOString() },
    }),
  );
}

/** What a fake core's `answer` gives for a request the core refuses, as GraphQL errors. */
export class GraphQLErrors {
  constructor(readonly errors: { message: string; extensions: { code: string } }[]) {}
}

/** The core's refusal of a sensitive mutation until the member confirms who they are. */
export const REAUTHENTICATE = new GraphQLErrors([
  {
    message: 'Confirm who you are first',
    extensions: { code: 'REAUTHENTICATION_REQUIRED' },
  },
]);

export interface Sent {
  operation: string;
  variables: Record<string, unknown>;
  /** For `/auth` paths, as they take more than one. */
  method?: string;
}

/**
 * A fake core: `/auth/me` puts the member in `shop_1` with `role`, and each Admin API request is
 * answered by `answer` with its operation's name and variables, and kept in `sent`.
 */
export function fakeCore(
  role: StaffRole,
  answer: (operation: string, variables: Record<string, unknown>) => unknown,
  /** `/auth` paths other than `/auth/me`, answered by `auth`; a status of its own where given. */
  auth: (path: string, body: unknown, method: string) => unknown = () => ({}),
  /** Laid over `/auth/me`'s account: its user's details, its Google account. */
  account: { user?: object; google?: object | null } = {},
) {
  const sent: Sent[] = [];
  /** Files put to storage's signed URLs, as a browser uploads them. */
  const uploads: { url: string; type: string | null; size: number }[] = [];
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  const fetcher = vi.fn(async (path: string, init?: RequestInit) => {
    if (init?.method === 'PUT') {
      const body = init.body as Blob;
      uploads.push({
        url: path,
        type: new Headers(init.headers).get('content-type'),
        size: body.size,
      });
      return new Response(null, { status: 200 });
    }
    const method = init?.method ?? 'GET';
    if (path === '/auth/me') {
      return json({
        session: { id: 'ses_1', mfaVerified: true },
        shops: [{ id: 'shop_1', name: 'Zari', role, mfaRequired: false }],
        ...account,
        user: { id: 'usr_1', name: 'Sana', language: 'en', ...account.user },
      });
    }
    if (path.startsWith('/auth/')) {
      const body: unknown = init?.body ? JSON.parse(String(init.body)) : null;
      sent.push({ operation: path, variables: (body ?? {}) as Record<string, unknown>, method });
      const answered = auth(path, body, method);
      if (answered instanceof Response) return answered;
      return json(answered);
    }
    const { query, variables } = JSON.parse(String(init!.body)) as {
      query: string;
      variables: Record<string, unknown>;
    };
    const operation = /(?:query|mutation) (\w+)/.exec(query)![1]!;
    sent.push({ operation, variables });
    if (operation === 'Shop') {
      return json({
        data: {
          shop: {
            id: 'shop_1',
            name: 'Zari',
            handle: 'zari',
            currencyCode: 'PKR',
            timezone: 'Asia/Karachi',
          },
        },
      });
    }
    const data = answer(operation, variables);
    if (data instanceof GraphQLErrors) return json({ data: null, errors: data.errors });
    return json({ data });
  });
  return { fetcher, sent, uploads };
}

/** The admin as a browser shows it, opened at `path`. */
export function renderAdmin(path: string) {
  const session = new SessionStore(browserFetch);
  const router = createAdminRouter(session, createMemoryHistory({ initialEntries: [path] }));
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <LocaleProvider initial="en">
      <SessionProvider store={session}>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </SessionProvider>
    </LocaleProvider>,
  );
  return { router };
}

export const press = async (name: string) => {
  await act(async () => fireEvent.click(screen.getByRole('button', { name })));
};

export const type = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
