import { useQueryClient } from '@tanstack/react-query';
import {
  createRootRouteWithContext,
  type RouterHistory,
  createRoute,
  createRouter,
  Outlet,
  redirect,
  useNavigate,
  useRouterState,
} from '@tanstack/react-router';
import { useEffect } from 'react';
import { useSession } from './auth/context';
import type { SessionStore } from './auth/session';
import { SignInPage } from './auth/sign-in-page';
import { SignUpPage } from './auth/sign-up-page';
import { TwoStepPage } from './auth/two-step-page';
import { DeskPage } from './desk/desk-page';
import { HomePage } from './home/home-page';
import { useLocale } from './i18n/locale';
import { OrderPage } from './orders/order-page';
import { OrdersPage, validateOrdersSearch } from './orders/orders-page';
import { Shell } from './shell/shell';
import { ShopsPage } from './shops/shops-page';
import { EmptyState } from './ui/feedback';

export interface RouterContext {
  session: SessionStore;
}

/** The screens a signed-out visitor may see. */
const PUBLIC_PATHS = ['/sign-in', '/sign-up'];

/**
 * The root: sends a visitor whose session ends, here or in another tab, back to signing in, and
 * forgets what the session read.
 */
function Root() {
  const { signedIn } = useSession();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  useEffect(() => {
    if (signedIn || PUBLIC_PATHS.includes(pathname)) return;
    queryClient.clear();
    void navigate({ to: '/sign-in', replace: true });
  }, [signedIn, pathname, navigate, queryClient]);
  return <Outlet />;
}

function NotFound() {
  const { t } = useLocale();
  return <EmptyState title={t('order.notFound')} />;
}

const root = createRootRouteWithContext<RouterContext>()({
  component: Root,
  notFoundComponent: NotFound,
});

function requireSignedIn({ context }: { context: RouterContext }) {
  if (!context.session.getSnapshot().signedIn) throw redirect({ to: '/sign-in' });
}

function requireSignedOut({ context }: { context: RouterContext }) {
  if (context.session.getSnapshot().signedIn) throw redirect({ to: '/shops' });
}

const index = createRoute({
  getParentRoute: () => root,
  path: '/',
  beforeLoad: ({ context }) => {
    throw redirect({ to: context.session.getSnapshot().signedIn ? '/shops' : '/sign-in' });
  },
});

const signIn = createRoute({
  getParentRoute: () => root,
  path: '/sign-in',
  beforeLoad: requireSignedOut,
  component: SignInPage,
});

const signUp = createRoute({
  getParentRoute: () => root,
  path: '/sign-up',
  beforeLoad: requireSignedOut,
  component: SignUpPage,
});

const twoStep = createRoute({
  getParentRoute: () => root,
  path: '/two-step',
  validateSearch: (search: Record<string, unknown>): { shop?: string } => ({
    shop: typeof search.shop === 'string' ? search.shop : undefined,
  }),
  beforeLoad: requireSignedIn,
  component: TwoStepPage,
});

const shops = createRoute({
  getParentRoute: () => root,
  path: '/shops',
  beforeLoad: requireSignedIn,
  component: ShopsPage,
});

const shop = createRoute({
  getParentRoute: () => root,
  path: '/$shopId',
  beforeLoad: requireSignedIn,
  component: Shell,
});

const home = createRoute({
  getParentRoute: () => shop,
  path: '/',
  component: HomePage,
});

const orders = createRoute({
  getParentRoute: () => shop,
  path: 'orders',
  validateSearch: validateOrdersSearch,
  component: OrdersPage,
});

const desk = createRoute({
  getParentRoute: () => shop,
  path: 'desk',
  component: DeskPage,
});

const order = createRoute({
  getParentRoute: () => shop,
  path: 'orders/$orderId',
  component: OrderPage,
});

export const routeTree = root.addChildren([
  index,
  signIn,
  signUp,
  twoStep,
  shops,
  shop.addChildren([home, orders, order, desk]),
]);

/** The admin's router; tests give it a history of their own. */
export function createAdminRouter(session: SessionStore, history?: RouterHistory) {
  return createRouter({ routeTree, context: { session }, defaultPreload: 'intent', history });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAdminRouter>;
  }
}
