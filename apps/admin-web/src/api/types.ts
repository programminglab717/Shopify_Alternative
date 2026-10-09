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
  /** One of the shop's tax categories' codes; null for the shop's own rate. */
  taxCode: string | null;
  selectedOptions: { name: string; value: string }[];
  inventoryQuantity: number;
  inventoryItem: {
    id: string;
    tracked: boolean;
    /** Whether it is sold once none is available: CONTINUE keeps selling, DENY stops. */
    inventoryPolicy: 'CONTINUE' | 'DENY';
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
  whatsappMarketingConsent: { marketingState: MarketingState };
  smsMarketingConsent: { marketingState: MarketingState };
  emailMarketingConsent: { marketingState: MarketingState };
  /** When their data will be erased, as they asked; null while none is waiting. */
  erasureScheduledAt: string | null;
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

export interface BlocklistEntryValue {
  id: string;
  /** E.164, masked for staff who see numbers masked. */
  phone: string;
  reason: BlocklistReason;
  note: string;
  createdAt: string;
  customer: { id: string; displayName: string } | null;
}

export interface BlocklistData {
  blocklist: {
    nodes: BlocklistEntryValue[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
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

export interface CourierPickup {
  id: string;
  accountId: string;
  courierName: string;
  status: 'REQUESTING' | 'REQUESTED' | 'FAILED';
  parcelCount: number;
  reference: string | null;
  loadSheetUrl: string | null;
  error: string | null;
  riderName: string | null;
  riderCode: string | null;
  createdAt: string;
  requestedAt: string | null;
}

export interface PickupsData {
  shop: { timezone: string };
  couriers: { courier: string; pickups: { rider: boolean } | null }[];
  courierAccounts: (CourierAccount & { courier: string })[];
  courierPickups: CourierPickup[];
}

export interface CourierPickupRequestData {
  courierPickupRequest: { courierPickup: CourierPickup | null; userErrors: UserError[] };
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

export type PaperSize = 'THERMAL_4X6' | 'A4' | 'THERMAL_80MM';

export type DocumentLanguage = 'BILINGUAL' | 'ENGLISH' | 'URDU';

/** What is printed for an order: what goes in its parcel, or what it cost and what is owed. */
export type OrderDocumentKind = 'PACKING_SLIP' | 'INVOICE';

export interface OrderDocumentData {
  orderDocument: { title: string; html: string };
}

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

/** A period's sessions on the online store and how far they went (ADR-180). */
export interface StorefrontSessionCounts {
  sessions: number;
  addedToCart: number;
  reachedCheckout: number;
  converted: number;
  /** Converted over sessions, 0 to 1; null without sessions. */
  conversionRate: number | null;
}

export interface StorefrontSessionsData {
  storefrontSessions: {
    totals: StorefrontSessionCounts;
    periods: { start: string; sessions: { sessions: number; converted: number } }[];
  };
  previous: { totals: StorefrontSessionCounts };
}

export interface StorefrontLiveViewData {
  storefrontLiveView: { visitorsNow: number; today: StorefrontSessionCounts };
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

/** Something of the shop's with words to put in Urdu, and its Urdu as kept (OS-06). */
export interface UrduResource {
  resourceId: string;
  translatableContent: { key: string; value: string | null; digest: string | null }[];
  translations: { key: string; value: string | null; outdated: boolean }[];
}

export interface InUrduData {
  translatableResourcesByIds: { nodes: UrduResource[] };
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

export interface SegmentValue {
  id: string;
  name: string;
  query: string;
  memberCount: number;
}

export interface SegmentsData {
  segments: { nodes: SegmentValue[] };
}

export interface SegmentData {
  segment: SegmentValue | null;
}

export type SegmentFieldType = 'BOOLEAN' | 'DATE' | 'MONEY' | 'NUMBER' | 'TEXT' | 'TEXT_LIST';

export interface SegmentFilterValue {
  name: string;
  type: SegmentFieldType;
  description: string;
  example: string;
  operators: string[];
}

export interface SegmentFiltersData {
  segmentFilters: SegmentFilterValue[];
}

export interface SegmentPreviewData {
  segmentPreview: { memberCount: number; members: CustomerListItem[] };
}

export interface SegmentMutationData {
  [field: string]: {
    segment?: { id: string } | null;
    deletedSegmentId?: string | null;
    userErrors: UserError[];
  };
}

export interface CustomersExportData {
  customersExport: { csv: string | null; rowCount: number; userErrors: UserError[] };
}

export interface CustomersImportResult {
  dryRun: boolean;
  rows: number;
  created: number;
  updated: number;
  skipped: number;
  rowErrorCount: number;
  rowErrors: { row: number; column: string | null; message: string }[];
  userErrors: UserError[];
}

export interface CustomersImportData {
  customersImport: CustomersImportResult;
}

export interface LinkPageLink {
  title: string;
  url: string;
}

export interface LinkPageProduct {
  productId: string;
  variantId: string | null;
}

export interface LinkPage {
  bio: string;
  links: LinkPageLink[];
  products: LinkPageProduct[];
}

export interface LinkPageData {
  shop: { id: string; url: string };
  onlineStorePreferences: { whatsappNumber: string | null; linkPage: LinkPage };
}

export interface LinkPageUpdateData {
  onlineStorePreferencesUpdate: {
    preferences: { linkPage: LinkPage } | null;
    userErrors: UserError[];
  };
}

export interface LinkPageProductData {
  product: {
    id: string;
    title: string;
    status: ProductStatus;
    media: { id: string; previewImage: { url: string } | null }[];
    variants: { id: string; title: string; price: MoneyValue }[];
  } | null;
}

export type LinkTapSource = 'LINK' | 'WHATSAPP' | 'REMOVED';

export interface LinkPageTapsData {
  linkPageTaps: {
    total: number;
    links: { url: string; title: string | null; source: LinkTapSource; taps: number }[];
  };
}

export type StoreCreditKind = 'CREDIT' | 'DEBIT' | 'DEBIT_REVERT' | 'EXPIRATION';
export type StoreCreditEvent =
  'ADJUSTMENT' | 'ORDER_CANCELLATION' | 'ORDER_PAYMENT' | 'ORDER_REFUND';

export interface StoreCreditTransaction {
  id: string;
  kind: StoreCreditKind;
  event: StoreCreditEvent | null;
  amount: MoneyValue;
  balanceAfterTransaction: MoneyValue;
  remainingAmount: MoneyValue | null;
  expiresAt: string | null;
  createdAt: string;
  note: string;
  orderId: string | null;
}

export interface StoreCreditAccount {
  id: string;
  balance: MoneyValue;
  transactions?: { nodes: StoreCreditTransaction[] };
}

export interface CustomerStoreCreditData {
  customer: { id: string; storeCreditAccounts: { nodes: StoreCreditAccount[] } } | null;
}

export interface StoreCreditMoveData {
  [field: string]: {
    storeCreditAccountTransaction: { id: string } | null;
    userErrors: UserError[];
  };
}

export interface OrderPayWithStoreCreditData {
  orderPayWithStoreCredit: { order: { id: string } | null; userErrors: UserError[] };
}

export interface PaymentLinkValue {
  id: string;
  title: string;
  url: string;
  active: boolean;
  open: boolean;
  ordersPlaced: number;
  usageLimit: number | null;
  prepaidOnly: boolean;
  discountCode: string | null;
  expiresAt: string | null;
  lastOrderAt: string | null;
  createdAt: string;
  items: { variantId: string; title: string | null; quantity: number }[];
}

export interface PaymentLinksData {
  paymentLinks: PaymentLinkValue[];
}

export interface PaymentLinkCreateData {
  paymentLinkCreate: { paymentLink: PaymentLinkValue | null; userErrors: UserError[] };
}

export interface PaymentLinkUpdateData {
  paymentLinkUpdate: {
    paymentLink: { id: string; active: boolean; open: boolean } | null;
    userErrors: UserError[];
  };
}

export interface SupportGrant {
  id: string;
  open: boolean;
  note: string | null;
  grantedBy: string;
  createdAt: string;
  expiresAt: string;
  endedAt: string | null;
  endedBy: string | null;
}

export interface SupportAccessData {
  supportAccess: SupportGrant | null;
  supportAccessGrants: SupportGrant[];
}

export interface SupportAccessGrantData {
  supportAccessGrant: { grant: SupportGrant | null; userErrors: UserError[] };
}

export interface SupportAccessEndData {
  supportAccessEnd: { grant: { id: string } | null; userErrors: UserError[] };
}

export type OrderExportFormat = 'CSV' | 'XLSX';
export type OrderExportLayout = 'ORDERS' | 'LINE_ITEMS';
export type OrderExportFrequency = 'DAILY' | 'WEEKLY' | 'MONTHLY';

export interface OrdersExportData {
  ordersExport: {
    rowCount: number;
    file: { content: string; contentType: string; filename: string } | null;
    userErrors: UserError[];
  };
}

export interface ExportSchedule {
  id: string;
  frequency: OrderExportFrequency;
  hour: number;
  format: OrderExportFormat;
  layout: OrderExportLayout;
  query: string;
  staffMemberId: string;
  nextSendAt: string;
  nextPeriodFirstDay: string;
  nextPeriodLastDay: string;
  lastSentAt: string | null;
  lastError: string | null;
}

export interface OrderExportSchedulesData {
  orderExportSchedules: ExportSchedule[];
}

export interface OrderExportScheduleCreateData {
  orderExportScheduleCreate: { exportSchedule: ExportSchedule | null; userErrors: UserError[] };
}

export interface OrderExportScheduleDeleteData {
  orderExportScheduleDelete: { deletedExportScheduleId: string | null; userErrors: UserError[] };
}

export interface TaxCategory {
  code: string;
  name: string;
  rate: number;
}

export interface TaxSettings {
  rate: number | null;
  taxDelivery: boolean;
  ntn: string | null;
  strn: string | null;
  updatedAt: string | null;
  categories: TaxCategory[];
}

export interface TaxSettingsData {
  taxSettings: TaxSettings;
}

export interface TaxSettingsUpdateData {
  taxSettingsUpdate: { taxSettings: TaxSettings | null; userErrors: UserError[] };
}

/** A moment of an order placed through checkout that the ad platforms hear of. */
export type ConversionMoment = 'PLACED' | 'CONFIRMED' | 'DELIVERED';

export type ConversionStatus = 'PENDING' | 'SENT' | 'FAILED' | 'EXPIRED' | 'SKIPPED';

/** The shop's Meta dataset (ADR-143): its token never shown, its last four characters alone. */
export interface MetaConversions {
  pixelId: string;
  accessTokenHint: string;
  purchaseAt: ConversionMoment;
  testEventCode: string | null;
  updatedAt: string;
}

export interface MetaConversionsData {
  metaConversions: MetaConversions | null;
  shop: { id: string; productFeedUrl: string };
}

export interface MetaConversionsUpdateData {
  metaConversionsUpdate: { metaConversions: MetaConversions | null; userErrors: UserError[] };
}

export interface MetaConversionsDeleteData {
  metaConversionsDelete: { deletedPixelId: string | null; userErrors: UserError[] };
}

export interface ConversionEvent {
  id: string;
  orderId: string;
  moment: ConversionMoment;
  eventName: string | null;
  status: ConversionStatus;
  attempts: number;
  error: string | null;
  traceId: string | null;
  occurredAt: string;
  sentAt: string | null;
}

export interface ConversionEventsData {
  conversionEvents: { nodes: ConversionEvent[]; pageInfo: { hasNextPage: boolean } };
}

export type MessageRouting = 'RICH' | 'ECONOMY';
export type MessageLanguage = 'EN' | 'UR';
export type MessageChannel = 'WHATSAPP' | 'SMS' | 'EMAIL';
export type MessageStatus = 'PENDING' | 'SENT' | 'DELIVERED' | 'READ' | 'FAILED' | 'SKIPPED';

/** How the shop's customers are told of their orders (MSG-01, ADR-146). */
export interface MessagingSettings {
  routing: MessageRouting;
  language: MessageLanguage;
  disabledNotifications: string[];
  alertsPhone: string | null;
  updatedAt: string | null;
}

export interface MessagingSettingsData {
  messagingSettings: MessagingSettings;
  billingMessagePrices: { category: string; channel: MessageChannel; price: MoneyValue }[];
}

export interface MessagingSettingsUpdateData {
  messagingSettingsUpdate: { messagingSettings: MessagingSettings | null; userErrors: UserError[] };
}

/** A message about an order, and how sending it went. */
export interface SentMessage {
  id: string;
  kind: string;
  channel: MessageChannel;
  status: MessageStatus;
  recipient: string;
  orderId: string | null;
  error: string | null;
  attempts: number;
  createdAt: string;
  sentAt: string | null;
  deliveredAt: string | null;
  readAt: string | null;
}

export interface MessagesData {
  messages: { nodes: SentMessage[]; pageInfo: { hasNextPage: boolean } };
}

export type CustomerCancellation = 'UNTIL_CONFIRMED' | 'UNTIL_PACKED';

/** The shop's policies for its orders, but for risk (COD-05, ADR-168). */
export interface OrderSettings {
  callingHours: { opens: string; closes: string } | null;
  firstCallMinutes: number | null;
  deskWaitsForReminder: boolean;
  cancelUnpaidAfterDays: number | null;
  cancelUnreachableAfterDays: number | null;
  customerCancellation: CustomerCancellation;
  updatedAt: string | null;
}

/** When risky cash-on-delivery orders wait for review (COD-06). */
export interface OrderRiskSettings {
  highValue: MoneyValue;
  holdAt: number | null;
  updatedAt: string | null;
}

export interface OrderPoliciesData {
  orderSettings: OrderSettings;
  orderRiskSettings: OrderRiskSettings;
}

export interface OrderSettingsUpdateData {
  orderSettingsUpdate: { orderSettings: OrderSettings | null; userErrors: UserError[] };
}

export interface OrderRiskSettingsUpdateData {
  orderRiskSettingsUpdate: { riskSettings: OrderRiskSettings | null; userErrors: UserError[] };
}

export type MarketingState = 'SUBSCRIBED' | 'NOT_SUBSCRIBED' | 'UNSUBSCRIBED';
export type MarketingChannel = 'WHATSAPP' | 'SMS' | 'EMAIL';

export interface CustomerCreateData {
  customerCreate: { customer: { id: string } | null; userErrors: UserError[] };
}

export interface CustomerMergeData {
  customerMerge: { customer: { id: string } | null; userErrors: UserError[] };
}

export interface CustomerMarketingConsentUpdateData {
  customerMarketingConsentUpdate: { customer: { id: string } | null; userErrors: UserError[] };
}

export interface CustomerDataExportData {
  customerDataExport: { fileName: string | null; json: string | null; userErrors: UserError[] };
}

export interface CustomerErasureRequestData {
  customerErasureRequest: { erasureScheduledAt: string | null; userErrors: UserError[] };
}

export interface CustomerErasureCancelData {
  customerErasureCancel: { userErrors: UserError[] };
}

export interface CustomerErasureRequestsData {
  customerErasureRequests: {
    nodes: {
      requestedAt: string;
      scheduledAt: string;
      customer: { id: string; displayName: string; phone: string };
    }[];
  };
}

export type CheckoutTrustBadgeKind =
  'CASH_ON_DELIVERY' | 'OPEN_PARCEL' | 'ORIGINAL' | 'EXCHANGE' | 'RETURNS' | 'WHATSAPP';

/** A badge under the checkout's button (CHK-14): days for exchanges and returns alone. */
export interface CheckoutTrustBadge {
  kind: CheckoutTrustBadgeKind;
  days: number | null;
}

export interface CheckoutPageData {
  checkoutTrustBadges: CheckoutTrustBadge[];
  checkoutMarketingChannels: MarketingChannel[];
  onlineStorePreferences: { whatsappNumber: string | null };
}

export interface CheckoutTrustBadgesUpdateData {
  checkoutTrustBadgesUpdate: {
    checkoutTrustBadges: CheckoutTrustBadge[] | null;
    userErrors: UserError[];
  };
}

export interface CheckoutMarketingChannelsUpdateData {
  checkoutMarketingChannelsUpdate: {
    checkoutMarketingChannels: MarketingChannel[] | null;
    userErrors: UserError[];
  };
}

/** A row of an imported file the core could not take, the headings being row 1. */
export interface FileRowError {
  row: number;
  column: string | null;
  message: string;
}

export interface ProductsExportData {
  productsExport: { csv: string; productCount: number; rowCount: number };
}

export interface ProductsImportResult {
  dryRun: boolean;
  rows: number;
  created: number;
  updated: number;
  skipped: number;
  variants: number;
  images: number;
  stocked: number;
  rowErrorCount: number;
  rowErrors: FileRowError[];
  userErrors: UserError[];
}

export interface ProductsImportData {
  productsImport: ProductsImportResult;
}

export interface LocationsData {
  locations: { nodes: { id: string; name: string; isPrimary: boolean }[] };
}

export interface InventoryExportData {
  inventoryExport: { csv: string; productCount: number; rowCount: number };
}

export interface InventoryImportResult {
  dryRun: boolean;
  rows: number;
  counted: number;
  unchanged: number;
  rowErrorCount: number;
  rowErrors: FileRowError[];
  userErrors: UserError[];
}

export interface InventoryImportData {
  inventoryImport: InventoryImportResult;
}

/** A warehouse or shop of the business's, as settings shows it (INV-01). */
export interface ShopLocation {
  id: string;
  name: string;
  isPrimary: boolean;
  isActive: boolean;
  fulfillsOnlineOrders: boolean;
  address: {
    address1: string | null;
    address2: string | null;
    city: string | null;
    province: string | null;
    zip: string | null;
    phone: string | null;
    formatted: string[];
  };
}

export interface ShopLocationsData {
  locations: { nodes: ShopLocation[] };
}

/** What adding, changing, deactivating or activating a location answers, by its field. */
export interface LocationPayloadData {
  locationAdd?: { location: ShopLocation | null; userErrors: UserError[] };
  locationEdit?: { location: ShopLocation | null; userErrors: UserError[] };
  locationDeactivate?: { location: ShopLocation | null; userErrors: UserError[] };
  locationActivate?: { location: ShopLocation | null; userErrors: UserError[] };
}

export interface SavedSearch {
  id: string;
  name: string;
  query: string;
}

export interface SavedSearchesData {
  savedSearches: { nodes: SavedSearch[] };
}

export interface SavedSearchPayload {
  savedSearch: SavedSearch | null;
  userErrors: UserError[];
}

export interface ShopDomain {
  id: string;
  host: string;
  url: string;
  dnsTarget: string;
  isPrimary: boolean;
  isVerified: boolean;
  verifiedAt: string | null;
  unpointedSince: string | null;
}

export interface ShopDomainsData {
  shop: { url: string };
  domains: ShopDomain[];
}

export interface OnlineStoreTheme {
  id: string;
  name: string;
  role: 'MAIN' | 'UNPUBLISHED';
  base: string;
  previewUrl: string;
  createdAt: string;
  updatedAt: string;
}

export interface ThemesData {
  themes: { nodes: OnlineStoreTheme[] };
}

/** A theme as its editor needs it (ADR-323); schemas and files are JSON in strings. */
export interface ThemeEditorData {
  theme:
    | (OnlineStoreTheme & {
        version: number;
        editor: {
          settingsSchema: string;
          sections: { type: string; name: string; schema: string }[];
          files: { filename: string; body: string; own: boolean; problems: string[] }[];
        };
      })
    | null;
}

export interface ThemeChoicesData {
  menus: { nodes: { handle: string; title: string }[] };
  collections: { nodes: { handle: string; title: string }[] };
  products: { nodes: { handle: string }[] };
  pages: {
    nodes: {
      handle: string;
      templateSuffix: string | null;
      isPublished: boolean;
      publishedAt: string | null;
    }[];
  };
  blogs: { nodes: { handle: string; templateSuffix: string | null }[] };
  articles: {
    nodes: {
      handle: string;
      templateSuffix: string | null;
      isPublished: boolean;
      publishedAt: string | null;
      blog: { handle: string };
    }[];
  };
}
