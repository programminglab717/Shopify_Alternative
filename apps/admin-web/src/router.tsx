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
import { NewSegmentPage, SegmentPage, SegmentsPage } from './customers/segments';
import { CustomersTransferPage } from './customers/transfer-page';
import { BlockedPage } from './customers/blocked-page';
import { ErasuresPage } from './customers/care';
import { NewCustomerPage } from './customers/new-customer-page';
import { AgentsPage } from './desk/agents-page';
import { DeskPage } from './desk/desk-page';
import {
  ChangeEmailPage,
  ForgotPasswordPage,
  ResetPasswordPage,
  VerifyEmailPage,
} from './auth/email-link-pages';
import { AnalyticsPage } from './analytics/analytics-page';
import { CashPage } from './cash/cash-page';
import { ReturnsPage, validateReturnsSearch } from './returns/returns-page';
import { StatementPage } from './cash/statement-page';
import { StockPage } from './stock/stock-page';
import { NewPurchaseOrderPage } from './purchase-orders/new-purchase-order-page';
import { PurchaseOrderPage } from './purchase-orders/purchase-order-page';
import {
  PurchaseOrdersPage,
  validatePurchaseOrdersSearch,
} from './purchase-orders/purchase-orders-page';
import { SuppliersPage } from './purchase-orders/suppliers-page';
import { AccountPage } from './account/account-page';
import { ArticleEditorPage, NewArticlePage } from './online-store/articles';
import { BlogPage } from './online-store/blogs';
import { OnlineStorePage, validateOnlineStoreSearch } from './online-store/online-store-page';
import { MenuEditorPage } from './online-store/menus';
import { NewPagePage, PageEditorPage } from './online-store/pages';
import { PolicyPage } from './online-store/policies';
import { ThemeEditorPage } from './online-store/theme-editor';
import { CollectionPage } from './collections/collection-page';
import { CollectionsPage, NewCollectionPage } from './collections/collections-page';
import { DiscountsPage } from './discounts/discounts-page';
import { OrdersExportPage } from './orders/export-page';
import { PaymentLinksPage } from './payment-links/payment-links-page';
import { DraftPage } from './drafts/draft-page';
import { DraftsPage } from './drafts/drafts-page';
import { EditDraftPage } from './drafts/edit-draft-page';
import { NewDraftPage } from './drafts/new-draft-page';
import { InvitationPage } from './invitation/invitation-page';
import { HomePage } from './home/home-page';
import { useLocale } from './i18n/locale';
import { OrderPage } from './orders/order-page';
import { OrdersPage, validateOrdersSearch } from './orders/orders-page';
import { NewProductPage } from './products/new-product-page';
import { ProductPage, validateProductSearch } from './products/product-page';
import { ProductsPage, validateProductsSearch } from './products/products-page';
import { ActivityPage } from './settings/activity-page';
import { SupportAccessPage } from './settings/support-page';
import { TaxPage } from './settings/tax-page';
import { MessagesPage } from './settings/messages-page';
import { OrderPoliciesPage } from './settings/order-policies-page';
import { CheckoutPage } from './settings/checkout-page';
import { DomainsPage } from './settings/domains-page';
import { LocationsPage } from './settings/locations-page';
import { ProductFilesPage } from './products/files-page';
import { BankTransferPage } from './settings/bank-transfer-page';
import { BillingPage } from './settings/billing-page';
import { CashOnDeliveryPage } from './settings/cash-on-delivery-page';
import { CityNamesPage } from './settings/city-names-page';
import { CouriersPage } from './settings/couriers-page';
import { DeliveryPage } from './settings/delivery-page';
import { OnlinePaymentsPage } from './settings/online-payments-page';
import { SettingsPage } from './settings/settings-page';
import { ShopPage } from './settings/shop-page';
import { StaffPage } from './settings/staff-page';
import { MorePage, Shell } from './shell/shell';
import { ShippingPage, validateShippingSearch } from './shipping/shipping-page';
import { ShopsPage } from './shops/shops-page';
import {
  ArticleUrduPage,
  BlogUrduPage,
  CollectionUrduPage,
  HomeUrduPage,
  MenuUrduPage,
  PageUrduPage,
  ProductUrduPage,
} from './urdu/urdu-pages';
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

const deskAgents = createRoute({
  getParentRoute: () => shop,
  path: 'desk/agents',
  component: AgentsPage,
});

const ordersExport = createRoute({
  getParentRoute: () => shop,
  path: 'orders/export',
  validateSearch: validateOrdersSearch,
  component: OrdersExportPage,
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

const productFiles = createRoute({
  getParentRoute: () => shop,
  path: 'products/files',
  component: ProductFilesPage,
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

const drafts = createRoute({
  getParentRoute: () => shop,
  path: 'drafts',
  component: DraftsPage,
});

const newDraft = createRoute({
  getParentRoute: () => shop,
  path: 'drafts/new',
  component: NewDraftPage,
});

const draft = createRoute({
  getParentRoute: () => shop,
  path: 'drafts/$draftId',
  component: DraftPage,
});

const draftEdit = createRoute({
  getParentRoute: () => shop,
  path: 'drafts/$draftId/edit',
  component: EditDraftPage,
});

const analytics = createRoute({
  getParentRoute: () => shop,
  path: 'analytics',
  component: AnalyticsPage,
});

const returns = createRoute({
  getParentRoute: () => shop,
  path: 'returns',
  validateSearch: validateReturnsSearch,
  component: ReturnsPage,
});

const cash = createRoute({
  getParentRoute: () => shop,
  path: 'cash',
  component: CashPage,
});

const collections = createRoute({
  getParentRoute: () => shop,
  path: 'collections',
  component: CollectionsPage,
});

const newCollection = createRoute({
  getParentRoute: () => shop,
  path: 'collections/new',
  component: NewCollectionPage,
});

const collection = createRoute({
  getParentRoute: () => shop,
  path: 'collections/$collectionId',
  component: CollectionPage,
});

const onlineStore = createRoute({
  getParentRoute: () => shop,
  path: 'online-store',
  validateSearch: validateOnlineStoreSearch,
  component: OnlineStorePage,
});

const newPage = createRoute({
  getParentRoute: () => shop,
  path: 'online-store/pages/new',
  component: NewPagePage,
});

const pageEditor = createRoute({
  getParentRoute: () => shop,
  path: 'online-store/pages/$pageId',
  component: PageEditorPage,
});

const menuEditor = createRoute({
  getParentRoute: () => shop,
  path: 'online-store/menus/$menuId',
  component: MenuEditorPage,
});

const policy = createRoute({
  getParentRoute: () => shop,
  path: 'online-store/policies/$policy',
  component: PolicyPage,
});

const blog = createRoute({
  getParentRoute: () => shop,
  path: 'online-store/blogs/$blogId',
  component: BlogPage,
});

const newArticle = createRoute({
  getParentRoute: () => shop,
  path: 'online-store/blogs/$blogId/articles/new',
  component: NewArticlePage,
});

const productUrdu = createRoute({
  getParentRoute: () => shop,
  path: 'products/$productId/urdu',
  component: ProductUrduPage,
});

const collectionUrdu = createRoute({
  getParentRoute: () => shop,
  path: 'collections/$collectionId/urdu',
  component: CollectionUrduPage,
});

const pageUrdu = createRoute({
  getParentRoute: () => shop,
  path: 'online-store/pages/$pageId/urdu',
  component: PageUrduPage,
});

const blogUrdu = createRoute({
  getParentRoute: () => shop,
  path: 'online-store/blogs/$blogId/urdu',
  component: BlogUrduPage,
});

const articleUrdu = createRoute({
  getParentRoute: () => shop,
  path: 'online-store/articles/$articleId/urdu',
  component: ArticleUrduPage,
});

const menuUrdu = createRoute({
  getParentRoute: () => shop,
  path: 'online-store/menus/$menuId/urdu',
  component: MenuUrduPage,
});

const homeUrdu = createRoute({
  getParentRoute: () => shop,
  path: 'online-store/home-page/urdu',
  component: HomeUrduPage,
});

const themeEditor = createRoute({
  getParentRoute: () => shop,
  path: 'online-store/themes/$themeId',
  component: ThemeEditorPage,
});

const articleEditor = createRoute({
  getParentRoute: () => shop,
  path: 'online-store/articles/$articleId',
  component: ArticleEditorPage,
});

const segments = createRoute({
  getParentRoute: () => shop,
  path: 'customers/segments',
  component: SegmentsPage,
});

const newSegment = createRoute({
  getParentRoute: () => shop,
  path: 'customers/segments/new',
  component: NewSegmentPage,
});

const segment = createRoute({
  getParentRoute: () => shop,
  path: 'customers/segments/$segmentId',
  component: SegmentPage,
});

const customersTransfer = createRoute({
  getParentRoute: () => shop,
  path: 'customers/transfer',
  component: CustomersTransferPage,
});

const customersBlocked = createRoute({
  getParentRoute: () => shop,
  path: 'customers/blocked',
  component: BlockedPage,
});

const customersNew = createRoute({
  getParentRoute: () => shop,
  path: 'customers/new',
  component: NewCustomerPage,
});

const customersErasures = createRoute({
  getParentRoute: () => shop,
  path: 'customers/erasures',
  component: ErasuresPage,
});

const account = createRoute({
  getParentRoute: () => shop,
  path: 'account',
  component: AccountPage,
});

const stock = createRoute({
  getParentRoute: () => shop,
  path: 'stock',
  component: StockPage,
});

const purchaseOrders = createRoute({
  getParentRoute: () => shop,
  path: 'purchase-orders',
  validateSearch: validatePurchaseOrdersSearch,
  component: PurchaseOrdersPage,
});

const suppliers = createRoute({
  getParentRoute: () => shop,
  path: 'purchase-orders/suppliers',
  component: SuppliersPage,
});

const newPurchaseOrder = createRoute({
  getParentRoute: () => shop,
  path: 'purchase-orders/new',
  component: NewPurchaseOrderPage,
});

const purchaseOrder = createRoute({
  getParentRoute: () => shop,
  path: 'purchase-orders/$purchaseOrderId',
  component: PurchaseOrderPage,
});

const statement = createRoute({
  getParentRoute: () => shop,
  path: 'cash/$remittanceId',
  component: StatementPage,
});

const discounts = createRoute({
  getParentRoute: () => shop,
  path: 'discounts',
  component: DiscountsPage,
});

const paymentLinks = createRoute({
  getParentRoute: () => shop,
  path: 'payment-links',
  component: PaymentLinksPage,
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

const settingsCityNames = createRoute({
  getParentRoute: () => shop,
  path: 'settings/couriers/$accountId/cities',
  component: CityNamesPage,
});

const settingsStaff = createRoute({
  getParentRoute: () => shop,
  path: 'settings/staff',
  component: StaffPage,
});

const settingsActivity = createRoute({
  getParentRoute: () => shop,
  path: 'settings/activity',
  component: ActivityPage,
});

const settingsSupport = createRoute({
  getParentRoute: () => shop,
  path: 'settings/support',
  component: SupportAccessPage,
});

const settingsTax = createRoute({
  getParentRoute: () => shop,
  path: 'settings/tax',
  component: TaxPage,
});

const settingsMessages = createRoute({
  getParentRoute: () => shop,
  path: 'settings/messages',
  component: MessagesPage,
});

const settingsOrders = createRoute({
  getParentRoute: () => shop,
  path: 'settings/orders',
  component: OrderPoliciesPage,
});

const settingsCheckout = createRoute({
  getParentRoute: () => shop,
  path: 'settings/checkout',
  component: CheckoutPage,
});

const settingsDomains = createRoute({
  getParentRoute: () => shop,
  path: 'settings/domains',
  component: DomainsPage,
});

const settingsLocations = createRoute({
  getParentRoute: () => shop,
  path: 'settings/locations',
  component: LocationsPage,
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
    ordersExport,
    order,
    desk,
    deskAgents,
    products,
    newProduct,
    productFiles,
    product,
    productUrdu,
    customers,
    customer,
    shipping,
    drafts,
    newDraft,
    draft,
    draftEdit,
    discounts,
    paymentLinks,
    analytics,
    cash,
    statement,
    stock,
    purchaseOrders,
    suppliers,
    newPurchaseOrder,
    purchaseOrder,
    account,
    onlineStore,
    newPage,
    pageEditor,
    pageUrdu,
    menuEditor,
    menuUrdu,
    homeUrdu,
    policy,
    blog,
    blogUrdu,
    newArticle,
    articleEditor,
    articleUrdu,
    themeEditor,
    segments,
    newSegment,
    segment,
    customersTransfer,
    customersNew,
    customersBlocked,
    customersErasures,
    collections,
    newCollection,
    collection,
    collectionUrdu,
    returns,
    more,
    settings,
    settingsCouriers,
    settingsCityNames,
    settingsStaff,
    settingsDelivery,
    settingsCashOnDelivery,
    settingsBankTransfer,
    settingsShop,
    settingsOnlinePayments,
    settingsBilling,
    settingsActivity,
    settingsSupport,
    settingsTax,
    settingsMessages,
    settingsOrders,
    settingsCheckout,
    settingsDomains,
    settingsLocations,
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
