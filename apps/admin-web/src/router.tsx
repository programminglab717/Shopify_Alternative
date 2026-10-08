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
import { CustomerPage } from './customers/customer-page';
import { CustomersPage, validateCustomersSearch } from './customers/customers-page';
import { DeskPage } from './desk/desk-page';
import {
  ChangeEmailPage,
  ForgotPasswordPage,
  ResetPasswordPage,
  VerifyEmailPage,
} from './auth/email-link-pages';
import { InvitationPage } from './invitation/invitation-page';
import { HomePage } from './home/home-page';
import { useLocale } from './i18n/locale';
import { OrderPage } from './orders/order-page';
import { OrdersPage, validateOrdersSearch } from './orders/orders-page';
import { NewProductPage } from './products/new-product-page';
import { ProductPage, validateProductSearch } from './products/product-page';
import { ProductsPage, validateProductsSearch } from './products/products-page';
import { BankTransferPage } from './settings/bank-transfer-page';
import { BillingPage } from './settings/billing-page';
import { CashOnDeliveryPage } from './settings/cash-on-delivery-page';
import { CouriersPage } from './settings/couriers-page';
import { DeliveryPage } from './settings/delivery-page';
import { OnlinePaymentsPage } from './settings/online-payments-page';
import { SettingsPage } from './settings/settings-page';
import { ShopPage } from './settings/shop-page';
import { StaffPage } from './settings/staff-page';
import { MorePage, Shell } from './shell/shell';
import { ShippingPage, validateShippingSearch } from './shipping/shipping-page';
import { ShopsPage } from './shops/shops-page';
import { EmptyState } from './ui/feedback';

export interface RouterContext {
  session: SessionStore;
}

/** The screens a signed-out visitor may see. */
const PUBLIC_PATHS = [
  '/sign-in',
  '/sign-up',
  '/invitation',
  '/forgot-password',
  '/reset-password',
  '/verify-email',
  '/change-email',
];

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

const products = createRoute({
  getParentRoute: () => shop,
  path: 'products',
  validateSearch: validateProductsSearch,
  component: ProductsPage,
});

const newProduct = createRoute({
  getParentRoute: () => shop,
  path: 'products/new',
  component: NewProductPage,
});

const product = createRoute({
  getParentRoute: () => shop,
  path: 'products/$productId',
  validateSearch: validateProductSearch,
  component: ProductPage,
});

const customers = createRoute({
  getParentRoute: () => shop,
  path: 'customers',
  validateSearch: validateCustomersSearch,
  component: CustomersPage,
});

const customer = createRoute({
  getParentRoute: () => shop,
  path: 'customers/$customerId',
  component: CustomerPage,
});

const shipping = createRoute({
  getParentRoute: () => shop,
  path: 'shipping',
  validateSearch: validateShippingSearch,
  component: ShippingPage,
});

const more = createRoute({
  getParentRoute: () => shop,
  path: 'more',
  component: MorePage,
});

const settings = createRoute({
  getParentRoute: () => shop,
  path: 'settings',
  component: SettingsPage,
});

const settingsCouriers = createRoute({
  getParentRoute: () => shop,
  path: 'settings/couriers',
  component: CouriersPage,
});

const settingsStaff = createRoute({
  getParentRoute: () => shop,
  path: 'settings/staff',
  component: StaffPage,
});

const settingsBilling = createRoute({
  getParentRoute: () => shop,
  path: 'settings/billing',
  component: BillingPage,
});

const settingsShop = createRoute({
  getParentRoute: () => shop,
  path: 'settings/shop',
  component: ShopPage,
});

const settingsOnlinePayments = createRoute({
  getParentRoute: () => shop,
  path: 'settings/online-payments',
  component: OnlinePaymentsPage,
});

const settingsDelivery = createRoute({
  getParentRoute: () => shop,
  path: 'settings/delivery',
  component: DeliveryPage,
});

const settingsCashOnDelivery = createRoute({
  getParentRoute: () => shop,
  path: 'settings/cash-on-delivery',
  component: CashOnDeliveryPage,
});

const settingsBankTransfer = createRoute({
  getParentRoute: () => shop,
  path: 'settings/bank-transfer',
  component: BankTransferPage,
});

/** Asking for a link to set a new password, signed in or out. */
const forgotPassword = createRoute({
  getParentRoute: () => root,
  path: '/forgot-password',
  component: ForgotPasswordPage,
});

/** The pages the core's emails link to (ADR-165, ADR-172): open signed in or out. */
const resetPassword = createRoute({
  getParentRoute: () => root,
  path: '/reset-password',
  component: ResetPasswordPage,
});

const verifyEmail = createRoute({
  getParentRoute: () => root,
  path: '/verify-email',
  component: VerifyEmailPage,
});

const changeEmail = createRoute({
  getParentRoute: () => root,
  path: '/change-email',
  component: ChangeEmailPage,
});

/** An invitation's link: open signed in or out (ADR-101). */
const invitation = createRoute({
  getParentRoute: () => root,
  path: '/invitation',
  component: InvitationPage,
});

export const routeTree = root.addChildren([
  index,
  signIn,
  signUp,
  twoStep,
  shops,
  invitation,
  forgotPassword,
  resetPassword,
  verifyEmail,
  changeEmail,
  shop.addChildren([
    home,
    orders,
    order,
    desk,
    products,
    newProduct,
    product,
    customers,
    customer,
    shipping,
    more,
    settings,
    settingsCouriers,
    settingsStaff,
    settingsDelivery,
    settingsCashOnDelivery,
    settingsBankTransfer,
    settingsShop,
    settingsOnlinePayments,
    settingsBilling,
  ]),
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
