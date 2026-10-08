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
  codFee: MoneyValue;
  totalPrice: MoneyValue;
  amountPaid: MoneyValue;
  codAmount: MoneyValue;
  customer: { id: string; displayName: string; numberOfOrders: number } | null;
  shippingAddress: { name: string | null; phone: string | null; city: string; formatted: string[] };
  risk: {
    level: RiskLevel;
    score: number;
    reasons: { code: string; message: string }[];
  } | null;
  assignee: { name: string } | null;
  events: {
    nodes: {
      id: string;
      kind: string;
      message: string;
      createdAt: string;
      author: { name: string | null } | null;
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
