import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  Link,
  Outlet,
  RouterProvider,
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
  useNavigate,
  type RouterHistory,
} from '@tanstack/react-router';
import { useEffect } from 'react';
import { ActionsLogPage } from './actions-log';
import { ReportsPage } from './reports';
import { StoresPage } from './stores';
import { VerificationsPage } from './verifications';
import { consoleCall, whenSignedOut } from './api';
import { keepSession, sessionOf } from './session';
import { SignInPage, SignedInPage } from './sign-in';
import { SupportRequestsPage } from './support-requests';
import { Button, when } from './ui';

const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);

/** The console's frame for a signed-in agent: where they are, who they are, and signing out. */
function Shell() {
  const navigate = useNavigate();
  const session = sessionOf();
  useEffect(() => {
    whenSignedOut(() => void navigate({ to: '/sign-in', search: { error: 'ended' } }));
  }, [navigate]);
  const signOut = async () => {
    await consoleCall('/auth/sign-out', { method: 'POST' }).catch(() => undefined);
    keepSession(null);
    void navigate({ to: '/sign-in', search: {} });
  };
  const link = 'rounded-control px-3 py-2 hover:bg-canvas [&.active]:font-semibold';
  return (
    <div className="mx-auto flex min-h-screen max-w-5xl flex-col gap-4 p-4">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line pb-3">
        <nav className="flex flex-wrap items-center gap-1" aria-label="Console">
          <span className="mr-2 font-semibold">Hatti console</span>
          <Link to="/support" className={link}>
            Support requests
          </Link>
          <Link to="/reports" className={link}>
            Reports
          </Link>
          <Link to="/stores" search={{}} className={link}>
            Stores down
          </Link>
          <Link to="/verifications" className={link}>
            Verifications
          </Link>
          <Link to="/log" className={link}>
            Log
          </Link>
        </nav>
        {session && (
          <div className="flex items-center gap-3">
            <span className="text-secondary">
              {session.agent.email}, until {when(session.agent.expiresAt)}
            </span>
            <Button variant="secondary" onClick={() => void signOut()}>
              Sign out
            </Button>
          </div>
        )}
      </header>
      <main>
        <Outlet />
      </main>
    </div>
  );
}

const rootRoute = createRootRoute({ component: Outlet });

const signInRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sign-in',
  validateSearch: (search: Record<string, unknown>): { error?: string } => ({
    error: text(search.error),
  }),
  component: SignInPage,
});

const signedInRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/signed-in',
  validateSearch: (
    search: Record<string, unknown>,
  ): { code?: string; state?: string; error?: string } => ({
    code: text(search.code),
    state: text(search.state),
    error: text(search.error),
  }),
  component: SignedInPage,
});

/** Every other page is for a signed-in agent. */
const signedInLayout = createRoute({
  getParentRoute: () => rootRoute,
  id: 'agent',
  beforeLoad: () => {
    if (!sessionOf()) throw redirect({ to: '/sign-in', search: {} });
  },
  component: Shell,
});

const homeRoute = createRoute({
  getParentRoute: () => signedInLayout,
  path: '/',
  beforeLoad: () => {
    throw redirect({ to: '/support' });
  },
});

const supportRoute = createRoute({
  getParentRoute: () => signedInLayout,
  path: '/support',
  component: SupportRequestsPage,
});

const reportsRoute = createRoute({
  getParentRoute: () => signedInLayout,
  path: '/reports',
  component: ReportsPage,
});

const storesRoute = createRoute({
  getParentRoute: () => signedInLayout,
  path: '/stores',
  // A store to take down, from its report.
  validateSearch: (search: Record<string, unknown>): { shop?: string; reason?: string } => ({
    shop: text(search.shop),
    reason: text(search.reason),
  }),
  component: StoresPage,
});

const verificationsRoute = createRoute({
  getParentRoute: () => signedInLayout,
  path: '/verifications',
  component: VerificationsPage,
});

const logRoute = createRoute({
  getParentRoute: () => signedInLayout,
  path: '/log',
  component: ActionsLogPage,
});

const routeTree = rootRoute.addChildren([
  signInRoute,
  signedInRoute,
  signedInLayout.addChildren([
    homeRoute,
    supportRoute,
    reportsRoute,
    storesRoute,
    verificationsRoute,
    logRoute,
  ]),
]);

export function createConsoleRouter(history?: RouterHistory) {
  return createRouter({ routeTree, ...(history && { history }) });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createConsoleRouter>;
  }
}

export function App({
  router = createConsoleRouter(),
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
}: {
  router?: ReturnType<typeof createConsoleRouter>;
  queryClient?: QueryClient;
}) {
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
