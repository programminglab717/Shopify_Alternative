// What the documents in operations.ts answer, as far as the admin reads them.

export interface MoneyValue {
  amount: string;
  currencyCode: string;
}

export interface Tally {
  count: number;
  total: MoneyValue;
}

export type OrderStage =
  | 'NEEDS_CONFIRMATION'
  | 'NEEDS_REVIEW'
  | 'AWAITING_PAYMENT'
  | 'TO_PACK'
  | 'TO_BOOK'
  | 'PARTIALLY_FULFILLED'
  | 'IN_TRANSIT'
  | 'DELIVERED'
  | 'COMPLETED'
  | 'RETURNING'
  | 'RETURNED'
  | 'LOST'
  | 'CANCELLED';

export type OrderPaymentMethod = 'CASH_ON_DELIVERY' | 'PREPAID' | 'BANK_TRANSFER' | 'ONLINE';

export type OrderCancelReason =
  'CUSTOMER' | 'FRAUD' | 'INVENTORY' | 'MERGED' | 'NO_RESPONSE' | 'OTHER' | 'UNPAID';

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';

export interface UserError {
  field: string[] | null;
  code: string;
  message: string;
}

export interface HomeData {
  shop: { timezone: string };
  home: Record<
    | 'toConfirm'
    | 'toReview'
    | 'awaitingPayment'
    | 'transfersToCheck'
    | 'toPack'
    | 'toBook'
    | 'returning'
    | 'returnsToReceive'
    | 'cashToCollect'
    | 'lostToClaim'
    | 'claimsOpen',
    Tally
  > & {
    today: {
      since: string;
      sales: Tally;
      salesYesterday: Tally;
      delivered: Tally;
      returnedToOrigin: Tally;
    };
  };
}

export type SetupStepKey =
  'PRODUCTS' | 'DELIVERY' | 'COURIERS' | 'PAYMENTS' | 'POLICIES' | 'BRAND' | 'WHATSAPP' | 'OPEN';

export interface SetupChecklistData {
  setupChecklist: {
    done: number;
    total: number;
    steps: { key: SetupStepKey; done: boolean; count: number | null }[];
  };
}

export interface OrderListItem {
  id: string;
  name: string;
  createdAt: string;
  stage: OrderStage;
  paymentMethod: OrderPaymentMethod;
  overPlanLimit: boolean;
  totalPrice: MoneyValue;
  customer: { displayName: string } | null;
  shippingAddress: { name: string | null; city: string };
  risk: { level: RiskLevel } | null;
  lineItems: { quantity: number }[];
}

export interface OrdersData {
  orders: {
    nodes: OrderListItem[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
  orderStageCounts: { stage: OrderStage; count: number }[];
}

export type FulfillmentStatus = 'IN_TRANSIT' | 'DELIVERED' | 'RETURNING' | 'RETURNED' | 'LOST';

export type FulfillmentEventStatus =
  | 'CONFIRMED'
  | 'IN_TRANSIT'
  | 'OUT_FOR_DELIVERY'
  | 'ATTEMPTED_DELIVERY'
  | 'DELIVERED'
  | 'RETURNING'
  | 'RETURNED'
  | 'FAILURE';

/** A parcel of an order, for its page. */
export interface ParcelDetail {
  id: string;
  status: FulfillmentStatus;
  shippedAt: string;
  deliveredAt: string | null;
  returningAt: string | null;
  returnedAt: string | null;
  lostAt: string | null;
  trackingInfo: { company: string | null; number: string | null; url: string | null };
  fulfillmentLineItems: {
    quantity: number;
    lineItem: { id: string; title: string; variantTitle: string | null };
  }[];
  events: {
    nodes: {
      id: string;
      status: FulfillmentEventStatus;
      message: string | null;
      happenedAt: string;
    }[];
  };
  claim: { status: FulfillmentClaimStatus } | null;
}

export type ReturnReason =
  | 'SIZE_TOO_SMALL'
  | 'SIZE_TOO_LARGE'
  | 'DEFECTIVE'
  | 'NOT_AS_DESCRIBED'
  | 'WRONG_ITEM'
  | 'UNWANTED'
  | 'OTHER';

/** A customer's return of an order's delivered items, for the order's page. */
export interface ReturnDetail {
  id: string;
  name: string;
  status: 'OPEN' | 'CLOSED' | 'CANCELLED';
  createdAt: string;
  closedAt: string | null;
  note: string;
  trackingInfo: { company: string | null; number: string | null };
  exchangeOrder: { id: string; name: string } | null;
  returnLineItems: {
    quantity: number;
    restockedQuantity: number | null;
    returnReason: ReturnReason;
    lineItem: { id: string };
  }[];
}

export interface ProductVariantsData {
  product: {
    id: string;
    variants: { id: string; title: string; availableForSale: boolean; inventoryQuantity: number }[];
  } | null;
}

export interface OpenReturnsData {
  openReturns: {
    nodes: {
      id: string;
      name: string;
      orderId: string;
      days: number;
      units: number;
      exchangeOrderName: string | null;
      trackingInfo: { company: string | null; number: string | null };
    }[];
    pageInfo: { hasNextPage: boolean };
  };
}

export interface ReturnCreateData {
  returnCreate: {
    return: { id: string; name: string; exchangeOrder: { id: string; name: string } | null } | null;
    userErrors: UserError[];
  };
}

export type RefundMethod =
  'CASH' | 'BANK_TRANSFER' | 'MOBILE_WALLET' | 'ONLINE' | 'STORE_CREDIT' | 'EXCHANGE' | 'OTHER';

/** Money given back on an order, for its page. */
export interface RefundDetail {
  id: string;
  amount: MoneyValue;
  method: RefundMethod;
  note: string;
  reference: string | null;
  createdAt: string;
  receipt: { url: string; mimeType: string } | null;
}

export interface OrderDetail {
  id: string;
  name: string;
  createdAt: string;
  stage: OrderStage;
  status: 'OPEN' | 'CLOSED' | 'CANCELLED';
  paymentMethod: OrderPaymentMethod;
  financialStatus: string;
  confirmationStatus: string;
  cancelReason: OrderCancelReason | null;
  overPlanLimit: boolean;
  note: string;
  tags: string[];
  phone: string | null;
  email: string | null;
  source: string;
  lineItems: {
    id: string;
    productId: string;
    variantId: string;
    title: string;
    variantTitle: string;
    sku: string | null;
    quantity: number;
    unitPrice: MoneyValue;
    totalPrice: MoneyValue;
  }[];
  subtotalPrice: MoneyValue;
  totalShippingPrice: MoneyValue;
  totalDiscounts: MoneyValue;
  /** What was taken off for paying by transfer: part of the discount, which never goes below it. */
  transferDiscount: MoneyValue;
  codFee: MoneyValue;
  totalPrice: MoneyValue;
  amountPaid: MoneyValue;
  codAmount: MoneyValue;
  customer: { id: string; displayName: string; numberOfOrders: number } | null;
  shippingAddress: {
    name: string | null;
    phone: string | null;
    address1: string | null;
    address2: string | null;
    landmark: string | null;
    city: string;
    province: string | null;
    zip: string | null;
    formatted: string[];
  };
  risk: {
    level: RiskLevel;
    score: number;
    reasons: { code: string; message: string }[];
  } | null;
  assignee: { id: string; name: string } | null;
  /** The order it was merged into, cancelled as MERGED (ADR-132). */
  mergedInto: { id: string; name: string } | null;
  /** The order its items were sent apart from (ADR-135). */
  splitFrom: { id: string; name: string } | null;
  fulfillments: ParcelDetail[];
  amountRefunded: MoneyValue;
  refunds: RefundDetail[];
  returns: ReturnDetail[];
  events: {
    nodes: {
      id: string;
      kind: string;
      message: string;
      createdAt: string;
      editedAt: string | null;
      author: { id: string; name: string | null } | null;
    }[];
  };
}

export interface OrderData {
  shop: { timezone: string };
  order: OrderDetail | null;
}

export interface OrderMutationData {
  [mutation: string]: { order: { id: string; stage: OrderStage } | null; userErrors: UserError[] };
}

export interface OrderBulkData {
  [mutation: string]: { orders: { id: string }[]; userErrors: UserError[] };
}

export type ConfirmationCallOutcome = 'NO_ANSWER' | 'CALL_BACK' | 'WRONG_NUMBER';

export interface DeskItem {
  claimedByYou: boolean;
  claimedUntil: string | null;
  dueAt: string;
  overdue: boolean;
  unansweredCalls: number;
  lastCall: {
    outcome: ConfirmationCallOutcome;
    note: string;
    createdAt: string;
    callBackAt: string | null;
  } | null;
  order: {
    id: string;
    name: string;
    createdAt: string;
    stage: OrderStage;
    paymentMethod: OrderPaymentMethod;
    overPlanLimit: boolean;
    note: string;
    phone: string | null;
    totalPrice: MoneyValue;
    codAmount: MoneyValue;
    shippingAddress: { name: string | null; city: string; formatted: string[] };
    customer: { displayName: string; numberOfOrders: number } | null;
    risk: { level: RiskLevel; score: number; reasons: { code: string; message: string }[] } | null;
    lineItems: { id: string; title: string; variantTitle: string; quantity: number }[];
  };
}

export interface ConfirmationQueueData {
  shop: { timezone: string };
  confirmationQueue: {
    callingNow: boolean;
    callingOpensAt: string | null;
    dueCount: number;
    laterCount: number;
    overdueCount: number;
    nodes: DeskItem[];
  };
}

export interface ConfirmationQueueNextData {
  confirmationQueueNext: { callingOpensAt: string | null; item: DeskItem | null };
}

export interface OrderPhoneRevealData {
  orderPhoneReveal: { phone: string | null; userErrors: UserError[] };
}

export type ProductStatus = 'ACTIVE' | 'DRAFT' | 'ARCHIVED';

export type MediaStatus = 'UPLOADED' | 'PROCESSING' | 'READY' | 'FAILED';

export interface ProductThumbnail {
  id: string;
  status: MediaStatus;
  previewImage: { url: string } | null;
}

export interface ProductMedia extends ProductThumbnail {
  alt: string;
  position: number;
  mediaContentType: 'IMAGE' | 'VIDEO' | 'EXTERNAL_VIDEO';
  mediaErrors: { message: string }[];
}

export interface ProductListItem {
  id: string;
  title: string;
  status: ProductStatus;
  productType: string | null;
  vendor: string | null;
  totalInventory: number;
  tracksInventory: boolean;
  priceRange: { minVariantPrice: MoneyValue; maxVariantPrice: MoneyValue };
  media: ProductThumbnail[];
  variants: { id: string }[];
}

export interface ProductsData {
  products: {
    nodes: ProductListItem[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

export interface ProductVariantDetail {
  id: string;
  title: string;
  price: MoneyValue;
  compareAtPrice: MoneyValue | null;
  sku: string | null;
  selectedOptions: { name: string; value: string }[];
  inventoryQuantity: number;
  inventoryItem: {
    id: string;
    tracked: boolean;
    inventoryLevels: { available: number; location: { id: string } }[];
  };
}

export interface ProductDetail {
  id: string;
  title: string;
  description: string;
  handle: string;
  status: ProductStatus;
  productType: string | null;
  vendor: string | null;
  tags: string[];
  totalInventory: number;
  tracksInventory: boolean;
  options: { id: string; name: string; optionValues: { id: string; name: string }[] }[];
  media: ProductMedia[];
  variants: ProductVariantDetail[];
}

export interface LocationRef {
  id: string;
  name: string;
}

export interface ProductData {
  location: LocationRef | null;
  product: ProductDetail | null;
}

export interface PrimaryLocationData {
  location: LocationRef | null;
}

export interface ProductCreateData {
  productCreate: {
    product: {
      id: string;
      variants: {
        id: string;
        inventoryItem: { id: string };
        selectedOptions: { name: string; value: string }[];
      }[];
    } | null;
    userErrors: UserError[];
  };
}

export interface ProductUpdateData {
  productUpdate: { product: { id: string } | null; userErrors: UserError[] };
}

export interface ProductVariantsBulkUpdateData {
  productVariantsBulkUpdate: { productVariants: { id: string }[] | null; userErrors: UserError[] };
}

export interface InventorySetQuantitiesData {
  inventorySetQuantities: { userErrors: UserError[] };
}

export interface ProductDeleteData {
  productDelete: { deletedProductId: string | null; userErrors: UserError[] };
}

export interface StagedTarget {
  url: string;
  httpMethod: string;
  resourceUrl: string;
  parameters: { name: string; value: string }[];
}

export interface StagedUploadsCreateData {
  stagedUploadsCreate: { stagedTargets: StagedTarget[] | null; userErrors: UserError[] };
}

export interface ProductCreateMediaData {
  productCreateMedia: {
    media: { id: string; status: MediaStatus }[] | null;
    userErrors: UserError[];
  };
}

export interface ProductDeleteMediaData {
  productDeleteMedia: { deletedMediaIds: string[] | null; userErrors: UserError[] };
}

export interface ProductReorderMediaData {
  productReorderMedia: { userErrors: UserError[] };
}

export type BlocklistReason = 'FRAUD' | 'FAKE_ORDERS' | 'REFUSED_DELIVERIES' | 'ABUSE' | 'OTHER';

export interface CustomerListItem {
  id: string;
  displayName: string;
  phone: string;
  numberOfOrders: number;
  lastOrderAt: string | null;
  tags: string[];
  amountSpent: MoneyValue;
  blocklistEntry: { id: string } | null;
}

export interface CustomersData {
  customers: {
    nodes: CustomerListItem[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

export interface CustomerDetail {
  id: string;
  displayName: string;
  name: string | null;
  phone: string;
  otherPhones: string[];
  email: string | null;
  note: string;
  tags: string[];
  createdAt: string;
  numberOfOrders: number;
  lastOrderAt: string | null;
  amountSpent: MoneyValue;
  deliveryHistory: {
    delivered: number;
    returned: number;
    cancelled: number;
    inProgress: number;
    lost: number;
  };
  blocklistEntry: {
    id: string;
    reason: BlocklistReason;
    note: string;
    createdAt: string;
  } | null;
  whatsappMarketingConsent: { marketingState: 'SUBSCRIBED' | 'NOT_SUBSCRIBED' | 'UNSUBSCRIBED' };
  addresses: { formatted: string[] }[];
  orders: {
    nodes: {
      id: string;
      name: string;
      createdAt: string;
      stage: OrderStage;
      totalPrice: MoneyValue;
    }[];
  };
}

export interface CustomerData {
  shop: { timezone: string };
  customer: CustomerDetail | null;
}

export interface CustomerUpdateData {
  customerUpdate: { customer: { id: string } | null; userErrors: UserError[] };
}

export interface CustomerPhoneRevealData {
  customerPhoneReveal: { phone: string | null; otherPhones: string[]; userErrors: UserError[] };
}

export interface BlocklistAddData {
  blocklistAdd: { blocklistEntry: { id: string } | null; userErrors: UserError[] };
}

export interface BlocklistRemoveData {
  blocklistRemove: { deletedBlocklistEntryId: string | null; userErrors: UserError[] };
}

export type CourierBookingStatus = 'PENDING' | 'BOOKED' | 'FAILED' | 'CANCELLED';

export type CourierParcelStatus =
  | 'BOOKED'
  | 'IN_TRANSIT'
  | 'OUT_FOR_DELIVERY'
  | 'ATTEMPTED'
  | 'DELIVERED'
  | 'RETURNING'
  | 'RETURNED'
  | 'LOST'
  | 'CANCELLED';

export interface CourierBooking {
  id: string;
  orderId: string;
  orderName: string;
  courierName: string;
  status: CourierBookingStatus;
  parcelStatus: CourierParcelStatus | null;
  trackingNumber: string | null;
  error: string | null;
  createdAt: string;
  bookedAt: string | null;
  codAmount: MoneyValue | null;
}

export interface CourierAccount {
  id: string;
  name: string;
  courierName: string;
  isDefault: boolean;
}

export interface ShippingData {
  shop: { timezone: string };
  courierAccounts: CourierAccount[];
  courierBookings: {
    nodes: CourierBooking[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

export interface OrdersBookData {
  ordersBook: {
    bookings: { id: string; orderName: string }[];
    refused: { orderId: string; message: string }[];
    userErrors: UserError[];
  };
}

export interface CourierBookingCancelData {
  courierBookingCancel: {
    courierBooking: { id: string; status: CourierBookingStatus } | null;
    userErrors: UserError[];
  };
}

export type PaperSize = 'THERMAL_4X6' | 'A4';

export interface CourierDocumentData {
  title: string;
  html: string;
}

export interface CourierOffered {
  courier: string;
  name: string;
  test: boolean;
  pickupCode: string | null;
  credentials: { key: string; label: string }[];
}

export interface CourierAccountDetail {
  id: string;
  name: string;
  courier: string;
  courierName: string;
  isDefault: boolean;
  credentialsHint: string;
  pickupCode: string | null;
  createdAt: string;
}

export interface CourierAccountsData {
  couriers: CourierOffered[];
  courierAccounts: CourierAccountDetail[];
}

export interface CourierAccountPayloadData {
  courierAccount: { id: string; name: string; isDefault: boolean } | null;
  userErrors: UserError[];
}

/** The API's names for staff roles. */
export type StaffMemberRole =
  'OWNER' | 'MANAGER' | 'CONFIRMATION_AGENT' | 'PACKER' | 'MARKETER' | 'ACCOUNTANT';

export interface StaffMember {
  id: string;
  name: string;
  email: string | null;
  role: StaffMemberRole;
  joinedAt: string;
}

export interface StaffInvitation {
  id: string;
  role: StaffMemberRole;
  note: string | null;
  email: string | null;
  invitedBy: string;
  expiresAt: string;
}

export interface StaffData {
  staffMembers: StaffMember[];
  staffInvitations: StaffInvitation[];
}

export interface StaffInvitationCreateData {
  staffInvitationCreate: {
    token: string | null;
    emailed: boolean;
    invitation: { id: string } | null;
    userErrors: UserError[];
  };
}

export interface DeliveryDaysValue {
  min: number;
  max: number;
}

export interface DeliverySettingsValue {
  charge: MoneyValue;
  freeAbove: MoneyValue | null;
  days: DeliveryDaysValue | null;
  zones: {
    name: string;
    cities: string[];
    charge: MoneyValue;
    days: DeliveryDaysValue | null;
  }[];
  updatedAt: string | null;
}

export interface DeliverySettingsData {
  deliverySettings: DeliverySettingsValue;
}

export type CashOnDeliveryAdvanceKind = 'DELIVERY_CHARGE' | 'FIXED_AMOUNT' | 'PERCENTAGE';

export interface CashOnDeliverySettingsValue {
  fee: MoneyValue;
  maxOrderTotal: MoneyValue | null;
  refusedDeliveriesLimit: number | null;
  riskScoreLimit: number | null;
  verifyFromScore: number | null;
  unavailableCities: string[];
  unavailableProductTags: string[];
  advance: {
    kind: CashOnDeliveryAdvanceKind;
    amount: MoneyValue | null;
    percentage: number | null;
    above: MoneyValue | null;
    cities: string[];
    productTags: string[];
    newCustomers: boolean;
    refusedDeliveries: number | null;
    riskScore: number | null;
  } | null;
  updatedAt: string | null;
}

export interface CashOnDeliverySettingsData {
  cashOnDeliverySettings: CashOnDeliverySettingsValue;
  bankTransferSettings: { enabled: boolean; account: { iban: string } | null };
}

export type TransferDiscountKind = 'FIXED_AMOUNT' | 'PERCENTAGE';

export interface BankTransferSettingsValue {
  enabled: boolean;
  account: {
    bankName: string;
    title: string;
    iban: string;
    raastId: string | null;
    instructions: string;
  } | null;
  discount: {
    kind: TransferDiscountKind;
    amount: MoneyValue | null;
    percentage: number | null;
    cap: MoneyValue | null;
  } | null;
  updatedAt: string | null;
}

export interface BankTransferSettingsData {
  bankTransferSettings: BankTransferSettingsValue;
}

export interface SettingsPayloadData {
  userErrors: UserError[];
}

export interface PaymentGatewayOffered {
  gateway: string;
  name: string;
  test: boolean;
  refunds: 'NONE' | 'PARTIAL' | 'WHOLE';
  credentials: { key: string; label: string; optional: boolean }[];
}

export interface PaymentGatewayAccountDetail {
  id: string;
  gateway: string;
  gatewayName: string;
  environment: 'PRODUCTION' | 'SANDBOX';
  credentialsHint: string;
  webhookUrl: string;
  createdAt: string;
}

export interface PaymentGatewaysData {
  paymentGateways: PaymentGatewayOffered[];
  paymentGatewayAccounts: PaymentGatewayAccountDetail[];
}

export interface PaymentGatewayAccountPayloadData {
  paymentGatewayAccount: PaymentGatewayAccountDetail | null;
  userErrors: UserError[];
}

export interface ShopDetailsData {
  shop: {
    brand: {
      logo: { id: string; url: string } | null;
      squareLogo: { id: string; url: string } | null;
    };
  };
  onlineStorePreferences: { whatsappNumber: string | null };
}

export type BillingPlanCode = 'FREE' | 'STARTER' | 'GROWTH' | 'PRO';
export type BillingInterval = 'MONTHLY' | 'YEARLY';

export interface BillingPlanValue {
  code: BillingPlanCode;
  name: string;
  monthlyPrice: MoneyValue;
  yearlyPrice: MoneyValue;
  orderLimit: number | null;
  staffLimit: number;
  locationLimit: number;
  customDomains: boolean;
  onlineGateways: boolean;
}

export interface BillingInvoiceValue {
  id: string;
  name: string;
  reason: 'CHANGE' | 'CREDITS' | 'RENEWAL';
  status: 'OPEN' | 'PAID' | 'VOID';
  interval: BillingInterval | null;
  createdAt: string;
  paidAt: string | null;
  amount: MoneyValue;
  plan: { name: string } | null;
  transfers: {
    id: string;
    reference: string;
    status: 'CONFIRMED' | 'REFUSED' | 'WAITING';
    refusal: string | null;
    reportedAt: string;
  }[];
}

export interface BillingData {
  billingSubscription: {
    plan: BillingPlanValue;
    interval: BillingInterval | null;
    periodEnd: string | null;
    pastDue: boolean;
    nextPlan: { name: string } | null;
    openInvoice: BillingInvoiceValue | null;
  };
  billingPlans: BillingPlanValue[];
  billingWallet: { balance: MoneyValue; openInvoice: BillingInvoiceValue | null };
  billingInvoices: BillingInvoiceValue[];
  billingBankAccount: {
    bankName: string;
    title: string;
    iban: string;
    raastId: string | null;
  } | null;
}

export type DiscountCodeKind = 'PERCENTAGE' | 'FIXED_AMOUNT' | 'FREE_SHIPPING';

export interface DiscountCodeValue {
  id: string;
  code: string;
  title: string;
  kind: DiscountCodeKind;
  summary: string;
  status: 'ACTIVE' | 'SCHEDULED' | 'EXPIRED';
  usageCount: number;
  usageLimit: number | null;
  startsAt: string;
  endsAt: string | null;
}

export interface DiscountCodesData {
  discountCodes: { nodes: DiscountCodeValue[] };
}

export interface DiscountCodePayloadData {
  discountCode: DiscountCodeValue | null;
  userErrors: UserError[];
}

export type DraftSource = 'WHATSAPP' | 'INSTAGRAM' | 'FACEBOOK' | 'MANUAL';

export interface DraftListItem {
  id: string;
  name: string;
  status: 'OPEN' | 'COMPLETED';
  source: string;
  createdAt: string;
  totalPrice: MoneyValue;
  shippingAddress: { name: string | null; city: string } | null;
  lineItems: { quantity: number }[];
}

export interface DraftOrdersData {
  draftOrders: { nodes: DraftListItem[] };
}

export interface DraftOrderDetail {
  id: string;
  name: string;
  status: 'OPEN' | 'COMPLETED';
  source: string;
  paymentMethod: string;
  note: string;
  createdAt: string;
  linkExpiresAt: string | null;
  phone: string | null;
  lineItems: {
    variantId: string;
    title: string;
    variantTitle: string;
    quantity: number;
    unitPrice: MoneyValue;
    totalPrice: MoneyValue;
  }[];
  shippingAddress: { formatted: string[] } | null;
  subtotalPrice: MoneyValue;
  totalShippingPrice: MoneyValue;
  totalDiscounts: MoneyValue;
  totalPrice: MoneyValue;
  codAmount: MoneyValue;
  order: { id: string; name: string } | null;
}

export interface DraftOrderData {
  draftOrder: DraftOrderDetail | null;
}

export interface DraftVariantsData {
  products: {
    nodes: {
      id: string;
      title: string;
      variants: {
        id: string;
        title: string;
        availableForSale: boolean;
        inventoryQuantity: number;
        price: MoneyValue;
      }[];
    }[];
  };
}

export interface ActivityActor {
  id: string;
  kind: 'APP' | 'STAFF' | 'SUPPORT';
  role: string | null;
}

export interface ActivityData {
  activityLog: {
    nodes: {
      id: string;
      type: string;
      subjectType: string;
      subjectId: string | null;
      occurredAt: string;
      actor: ActivityActor;
    }[];
    pageInfo: { hasNextPage: boolean };
  };
  staffMembers: { id: string; name: string }[];
}

export interface AuditData {
  auditLog: {
    nodes: {
      id: string;
      action: string;
      subjectId: string;
      occurredAt: string;
      actor: ActivityActor;
    }[];
    pageInfo: { hasNextPage: boolean };
  };
  staffMembers: { id: string; name: string }[];
}

export interface SalesTotalsValue {
  orders: number;
  netSales: MoneyValue;
  totalSales: MoneyValue;
  averageOrderValue: MoneyValue | null;
  returns: MoneyValue;
  profit: MoneyValue;
}

export interface SalesData {
  salesReport: {
    totals: SalesTotalsValue;
    previous: { totals: SalesTotalsValue };
    periods: { start: string; sales: { orders: number; netSales: MoneyValue } }[];
    topProducts: { productId: string; title: string; unitsSold: number; grossSales: MoneyValue }[];
    rows: { key: string | null; title: string; sales: { orders: number; netSales: MoneyValue } }[];
  };
}

export type CodHealthDimension = 'CITY' | 'PRODUCT' | 'SOURCE' | 'COURIER';

export interface CodDeliveryFigures {
  shipped: number;
  delivered: number;
  returned: number;
  inTransit: number;
  successRate: number | null;
  returnRate: number | null;
  returnCharges: MoneyValue;
}

export interface CodHealthData {
  codHealth: {
    confirmation: {
      placed: number;
      confirmed: number;
      cancelled: number;
      awaiting: number;
      rate: number | null;
    };
    delivery: CodDeliveryFigures;
    rows: {
      key: string | null;
      title: string;
      confirmation: { placed: number; rate: number | null } | null;
      delivery: CodDeliveryFigures;
    }[];
  };
}

export interface CodCashValue {
  amount: MoneyValue;
  count: number;
}

export interface CodReceivableAgeValue {
  fromDays: number;
  toDays: number | null;
  count: number;
  amount: MoneyValue;
}

export interface CodRemittanceSummary {
  id: string;
  courier: string;
  reference: string | null;
  createdAt: string;
  lineCount: number;
  issueCount: number;
  collected: MoneyValue;
  paid: MoneyValue;
  received: MoneyValue;
}

export interface CashData {
  codReceivables: {
    owed: CodCashValue;
    onTheWay: CodCashValue;
    ages: CodReceivableAgeValue[];
    couriers: {
      courier: string | null;
      oldestDeliveredAt: string;
      owed: CodCashValue;
      ages: CodReceivableAgeValue[];
    }[];
  };
  codRemittances: { nodes: CodRemittanceSummary[]; pageInfo: { hasNextPage: boolean } };
}

export type CodRemittanceOutcome =
  'CHARGED' | 'COMPENSATED' | 'NOT_OWED' | 'OVER' | 'RECEIVED' | 'REPEATED' | 'SHORT' | 'UNMATCHED';

export interface CodRemittanceLineValue {
  row: number;
  trackingNumber: string;
  outcome: CodRemittanceOutcome;
  orderId: string | null;
  orderName: string | null;
  collected: MoneyValue;
  received: MoneyValue;
  owed: MoneyValue | null;
}

export interface CashStatementData {
  codRemittance:
    | (CodRemittanceSummary & {
        charges: MoneyValue;
        tax: MoneyValue;
        compensated: MoneyValue;
        lines: CodRemittanceLineValue[];
      })
    | null;
}

export type CodRemittanceOutcomeCounts = Record<
  'charged' | 'compensated' | 'notOwed' | 'over' | 'received' | 'repeated' | 'short' | 'unmatched',
  number
>;

export interface CashStatementImportData {
  codRemittanceImport: {
    dryRun: boolean;
    rows: number;
    rowErrorCount: number;
    rowErrors: { row: number; column: string | null; message: string }[];
    outcomes: CodRemittanceOutcomeCounts;
    collected: MoneyValue;
    received: MoneyValue;
    paid: MoneyValue;
    remittance: { id: string } | null;
    userErrors: UserError[];
  };
}

export type FulfillmentClaimStatus = 'OPEN' | 'PAID' | 'REFUSED' | 'WITHDRAWN';

export interface ParcelClaimValue {
  status: FulfillmentClaimStatus;
  amount: MoneyValue;
  paid: MoneyValue | null;
  note: string | null;
  claimedAt: string;
  settledAt: string | null;
}

interface ParcelBase {
  id: string;
  orderId: string;
  orderName: string;
  trackingInfo: { company: string | null; number: string | null };
}

export interface ReturningParcelsData {
  returningParcels: {
    nodes: (ParcelBase & { days: number; units: number })[];
    pageInfo: { hasNextPage: boolean };
  };
}

export interface LostParcelsData {
  lostParcels: {
    nodes: (ParcelBase & {
      days: number;
      units: number;
      worth: MoneyValue;
      claim: ParcelClaimValue | null;
    })[];
    pageInfo: { hasNextPage: boolean };
  };
}

export interface ParcelClaimsData {
  parcelClaims: {
    nodes: (ParcelBase & { status: 'LOST' | 'RETURNED'; claim: ParcelClaimValue })[];
    pageInfo: { hasNextPage: boolean };
  };
}

export interface ParcelCheckInData {
  fulfillmentReceiveReturn: { order: { id: string; name: string } | null; userErrors: UserError[] };
}

export interface ParcelUserErrorsData {
  [mutation: string]: { userErrors: UserError[] };
}

/** What an edit of an order's items or charges left it at. */
export interface OrderEditData {
  [field: string]: {
    order: {
      id: string;
      stage: OrderStage;
      totalPrice: MoneyValue;
      codAmount: MoneyValue;
    } | null;
    userErrors: UserError[];
  };
}

/** The customer's orders, to choose one to merge into. */
export interface OrderMergeCandidatesData {
  order: {
    id: string;
    customer: {
      id: string;
      orders: {
        nodes: {
          id: string;
          name: string;
          createdAt: string;
          stage: OrderStage;
          status: OrderDetail['status'];
          paymentMethod: OrderPaymentMethod;
          totalPrice: MoneyValue;
          lineItems: { id: string; title: string; quantity: number }[];
        }[];
      };
    } | null;
  } | null;
}

/** An order merged into another, or items sent apart as one: the order that came of it. */
export interface OrderMergeSplitData {
  [field: string]: {
    order?: { id: string; name: string } | null;
    splitOrder?: { id: string; name: string } | null;
    userErrors: UserError[];
  };
}

export interface HomeStockData {
  home: { lowStock: { low: number; out: number; threshold: number } };
}

export interface LowStockData {
  inventorySettings: { lowStockThreshold: number };
  inventoryLowStock: {
    nodes: {
      variantId: string;
      variantTitle: string;
      productId: string;
      productTitle: string;
      sku: string | null;
      available: number;
      inventoryItem: { id: string };
    }[];
  };
}

export interface StockSearchData {
  products: {
    nodes: {
      id: string;
      title: string;
      variants: {
        id: string;
        title: string;
        sku: string | null;
        inventoryQuantity: number;
        inventoryItem: { id: string; tracked: boolean };
      }[];
    }[];
  };
}

export interface StockLevel {
  id: string;
  available: number;
  onHand: number;
  committed: number;
  reserved: number;
  safetyStock: number;
  location: { id: string; name: string };
}

export interface InventoryItemData {
  location: { id: string; name: string } | null;
  inventoryItem: {
    id: string;
    tracked: boolean;
    inventoryLevels: StockLevel[];
    changes: {
      nodes: {
        createdAt: string;
        delta: number;
        name: string;
        reason: string;
        quantityAfterChange: number;
        location: { id: string; name: string };
      }[];
    };
  } | null;
}

export type CollectionSortOrder =
  'MANUAL' | 'ALPHA_ASC' | 'ALPHA_DESC' | 'CREATED' | 'CREATED_DESC' | 'PRICE_ASC' | 'PRICE_DESC';

export type CollectionRuleColumn =
  | 'TAG'
  | 'TITLE'
  | 'TYPE'
  | 'VENDOR'
  | 'VARIANT_TITLE'
  | 'VARIANT_PRICE'
  | 'VARIANT_COMPARE_AT_PRICE'
  | 'VARIANT_WEIGHT'
  | 'IS_PRICE_REDUCED';

export type CollectionRuleRelation =
  | 'EQUALS'
  | 'NOT_EQUALS'
  | 'CONTAINS'
  | 'NOT_CONTAINS'
  | 'STARTS_WITH'
  | 'ENDS_WITH'
  | 'GREATER_THAN'
  | 'LESS_THAN'
  | 'IS_SET'
  | 'IS_NOT_SET';

export interface CollectionRule {
  column: CollectionRuleColumn;
  relation: CollectionRuleRelation;
  condition: string;
}

export interface CollectionsData {
  collections: {
    nodes: {
      id: string;
      title: string;
      productsCount: number;
      ruleSet: { appliedDisjunctively: boolean } | null;
    }[];
  };
}

export interface CollectionData {
  collection: {
    id: string;
    title: string;
    handle: string;
    description: string;
    sortOrder: CollectionSortOrder;
    productsCount: number;
    ruleSet: { appliedDisjunctively: boolean; rules: CollectionRule[] } | null;
    products: { nodes: { id: string; title: string; status: ProductStatus }[] };
  } | null;
}

export interface CollectionProductSearchData {
  products: { nodes: { id: string; title: string; status: ProductStatus }[] };
}

export interface CollectionMutationData {
  [field: string]: {
    collection?: { id: string } | null;
    deletedCollectionId?: string | null;
    userErrors: UserError[];
  };
}

export interface PageSummary {
  id: string;
  title: string;
  handle: string;
  isPublished: boolean;
  publishedAt: string | null;
}

export interface PagesData {
  pages: { nodes: PageSummary[] };
}

export interface PageData {
  page: (PageSummary & { body: string }) | null;
}

export interface PageMutationData {
  [field: string]: {
    page?: { id: string } | null;
    deletedPageId?: string | null;
    userErrors: UserError[];
  };
}

export type MenuItemType =
  | 'FRONTPAGE'
  | 'CATALOG'
  | 'COLLECTION'
  | 'PRODUCT'
  | 'PAGE'
  | 'BLOG'
  | 'ARTICLE'
  | 'HTTP'
  | 'COLLECTIONS'
  | 'SEARCH'
  | 'SHOP_POLICY'
  | 'CUSTOMER_ACCOUNT_PAGE'
  | 'METAOBJECT';

export interface MenuLink {
  id: string;
  title: string;
  type: MenuItemType;
  resourceId: string | null;
  url: string | null;
  items?: MenuLink[];
}

export interface Menu {
  id: string;
  title: string;
  handle: string;
  isDefault: boolean;
  items: MenuLink[];
}

export interface MenusData {
  menus: { nodes: Menu[] };
}

export interface MenuMutationData {
  [field: string]: {
    menu?: { id: string } | null;
    deletedMenuId?: string | null;
    userErrors: UserError[];
  };
}

export type ShopPolicyType =
  | 'REFUND_POLICY'
  | 'SHIPPING_POLICY'
  | 'PRIVACY_POLICY'
  | 'TERMS_OF_SERVICE'
  | 'CONTACT_INFORMATION';

export interface ShopPolicy {
  id: string;
  type: ShopPolicyType;
  title: string;
  body: string;
  url: string;
}

export interface PoliciesData {
  shop: { shopPolicies: ShopPolicy[] };
}

export interface PolicyDraftData {
  shopPolicyDraft: { title: string; body: string };
}

export interface PolicyTranslationData {
  translatableResource: {
    resourceId: string;
    translatableContent: { key: string; digest: string | null }[];
    translations: { key: string; value: string | null; outdated: boolean }[];
  } | null;
}

export type CommentPolicy = 'CLOSED' | 'MODERATED' | 'AUTO_PUBLISHED';
export type CommentStatus = 'PENDING' | 'PUBLISHED' | 'SPAM';

export interface BlogSummary {
  id: string;
  title: string;
  handle: string;
  commentPolicy: CommentPolicy;
  articlesCount: number;
}

export interface BlogsData {
  blogs: { nodes: BlogSummary[] };
}

export interface ArticleSummary {
  id: string;
  title: string;
  handle: string;
  isPublished: boolean;
  publishedAt: string | null;
  commentsCount: number;
}

export interface BlogData {
  blog: (BlogSummary & { articles: { nodes: ArticleSummary[] } }) | null;
}

export interface ArticleComment {
  id: string;
  body: string;
  status: CommentStatus;
  createdAt: string;
  author: { name: string; email: string };
}

export interface ArticleDetail {
  id: string;
  title: string;
  handle: string;
  body: string;
  summary: string | null;
  tags: string[];
  isPublished: boolean;
  publishedAt: string | null;
  author: { name: string } | null;
  image: { fileId: string; altText: string | null } | null;
  blog: Pick<BlogSummary, 'id' | 'title' | 'handle' | 'commentPolicy'>;
  comments: { nodes: ArticleComment[] };
}

export interface ArticleData {
  article: ArticleDetail | null;
}

export interface ShopFileData {
  file: { id: string; url: string; alt: string } | null;
}

/** What a blog's, an article's or a comment's mutation answers: what it made, or why not. */
export interface ContentMutationData {
  [field: string]: {
    blog?: { id: string } | null;
    article?: { id: string } | null;
    comment?: { id: string } | null;
    userErrors: UserError[];
  };
}

export interface StorefrontPreferences {
  passwordEnabled: boolean;
  password: string | null;
  passwordMessage: string;
  maintenanceEnabled: boolean;
  maintenanceMessage: string;
  maintenanceUntil: string | null;
  seo: { title: string | null; description: string | null };
}

export interface StorefrontPreferencesData {
  onlineStorePreferences: StorefrontPreferences;
}

export interface StorefrontPreferencesUpdateData {
  onlineStorePreferencesUpdate: {
    preferences: StorefrontPreferences | null;
    userErrors: UserError[];
  };
}

export interface UrlRedirectValue {
  id: string;
  path: string;
  target: string;
}

export interface UrlRedirectsData {
  urlRedirects: { nodes: UrlRedirectValue[]; pageInfo: { hasNextPage: boolean } };
}

export interface UrlRedirectsImportData {
  urlRedirectsImport: {
    dryRun: boolean;
    rows: number;
    created: number;
    skipped: number;
    rowErrorCount: number;
    rowErrors: { row: number; column: string | null; message: string }[];
    userErrors: UserError[];
  };
}

export interface UrlRedirectsExportData {
  urlRedirectsExport: { count: number; csv: string };
}
