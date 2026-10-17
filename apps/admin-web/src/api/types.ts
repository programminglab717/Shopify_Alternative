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
  | 'READY_FOR_PICKUP'
  | 'PARTIALLY_FULFILLED'
  | 'IN_TRANSIT'
  | 'DELIVERED'
  | 'COMPLETED'
  | 'RETURNING'
  | 'RETURNED'
  | 'LOST'
  | 'CANCELLED';

export type OrderPaymentMethod = 'CASH_ON_DELIVERY' | 'PREPAID' | 'BANK_TRANSFER' | 'ONLINE';

/** Sent, or collected at its location (SHP-15, ADR-389). */
export type OrderDeliveryMethod = 'SHIPPING' | 'PICKUP';

export type OrderCancelReason =
  'CUSTOMER' | 'DUPLICATE' | 'FRAUD' | 'INVENTORY' | 'MERGED' | 'NO_RESPONSE' | 'OTHER' | 'UNPAID';

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
    | 'readyForPickup'
    | 'returning'
    | 'returnsToReceive'
    | 'cashToCollect'
    | 'lostToClaim'
    | 'claimsOpen',
    Tally
  > & {
    /** Parcels handed to a rider a day ago and more that the courier has not seen (ADR-380). */
    parcelsUnseen: number;
    /** Parcels whose last step is a failed delivery (ADR-388). */
    deliveriesToRescue: number;
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

export interface FreshOrdersData {
  orders: { nodes: { id: string }[]; pageInfo: { hasNextPage: boolean } };
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
  /** What couriers' statements charged for it; null while none has. */
  courierCharges?: MoneyValue | null;
  /** What its account's rate card says it is likely to cost as it stands (ADR-383). */
  courierChargesEstimate?: MoneyValue | null;
  /** Its last hand-over to its courier's rider; null while none (ADR-381). */
  handOver: ParcelHandOverValue | null;
}

/** A parcel's last hand-over to its courier's rider, and what the courier said since (ADR-381). */
export interface ParcelHandOverValue {
  handedOverAt: string;
  byHand: boolean;
  riderName: string | null;
  /** The courier's tracking has had it as more than booked since. */
  seen: boolean;
  /** Still only booked a day after it was handed over (ADR-379). */
  unseen: boolean;
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
  /** Its credit note, given back once the order's invoice was issued (ADR-496). */
  creditNote: { number: string } | null;
}

export interface OrderDetail {
  id: string;
  name: string;
  /** Where it ships from, and where its stock is set aside. */
  location: { id: string; name: string };
  createdAt: string;
  stage: OrderStage;
  status: 'OPEN' | 'CLOSED' | 'CANCELLED';
  paymentMethod: OrderPaymentMethod;
  deliveryMethod: OrderDeliveryMethod;
  financialStatus: string;
  confirmationStatus: string;
  cancelReason: OrderCancelReason | null;
  overPlanLimit: boolean;
  note: string;
  /** The words to go with it as a gift (ADR-413); absent where a fake core leaves it out. */
  giftMessage?: string | null;
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
    /** The day it ships by, sold on pre-order (ADR-403); absent where a fake core leaves it out. */
    preorderShipsOn?: string | null;
    /** The bundle it was sold as a part of (ADR-410); absent where a fake core leaves it out. */
    bundle?: { key: string; title: string; quantity: number } | null;
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
  /** What a cash-on-delivery order asks for in advance, by transfer, before it ships; zero for none. */
  advanceDue: MoneyValue;
  /** Receipts its customer sent through its page for its transfer or advance, oldest first. */
  transferReceipts: { id: string; createdAt: string; mimeType: string; url: string }[];
  /** The customer's link, while it has one: when it stops working, null while it lasts. */
  customerLink: { expiresAt: string | null } | null;
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
  /** The earlier order of its customer's it may repeat, not shipped yet (CHK-11, ADR-392). */
  repeatOf: { id: string; name: string } | null;
  /** The order its items were sent apart from (ADR-135). */
  splitFrom: { id: string; name: string } | null;
  fulfillments: ParcelDetail[];
  amountRefunded: MoneyValue;
  refunds: RefundDetail[];
  /** Its invoice in the shop's series, once printed (ADR-495). */
  invoice: { number: string; issuedAt: string } | null;
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
  /** The payments its customer started online, the latest first. */
  paymentSessions: PaymentSessionValue[];
}

export interface OrderMutationData {
  [mutation: string]: { order: { id: string; stage: OrderStage } | null; userErrors: UserError[] };
}

/** What a bulk action on products did: those done, and why others not (CAT-04). */
export interface ProductBulkData {
  [mutation: string]: {
    products?: { id: string }[];
    deletedProductIds?: string[];
    userErrors: UserError[];
  };
}

/** What tagging customers many at once did: those done, and why others not. */
export interface CustomerBulkData {
  [mutation: string]: { customers: { id: string }[]; userErrors: UserError[] };
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
  /** Units of its variants sold in the last 30 days (ADR-372). */
  soldLast30Days: number;
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
  /** Units sold in the last 30 days, at all the shop's locations (ADR-370). */
  soldLast30Days: number;
  /** Whole days what can be sold online lasts at that pace; null when none sold. */
  daysOfStockLeft: number | null;
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
  /** Whether it is sold as a gift card (ADR-451); absent where a fake core leaves it out. */
  isGiftCard?: boolean;
  /** Its category in Google's taxonomy (ADR-483); absent where a fake core leaves it out. */
  category?: string | null;
  /** Whether it is new, refurbished or used (ADR-483); absent where a fake core leaves it out. */
  condition?: ProductConditionValue;
  /** Stitched or not, its pieces, fabrics and season (ADR-477); absent where a fake core leaves it out. */
  easternWear?: EasternWear | null;
  /** Its pre-order, if it is on one (ADR-403); absent where a fake core leaves it out. */
  preorder?: { shipsOn: string } | null;
  /** The size chart its page shows (ADR-406); absent where a fake core leaves it out. */
  sizeChart?: { id: string; name: string } | null;
  /** What it is made of, where it is a bundle (ADR-409); absent where a fake core leaves it out. */
  bundle?: ProductBundle | null;
  /**
   * The products the shop pairs with it, in order (ADR-435); absent where a fake core leaves it
   * out.
   */
  complementaryProducts?: { id: string; title: string }[];
  /** When the draft goes on sale by itself (ADR-441); absent where a fake core leaves it out. */
  publishAt?: string | null;
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

export interface ProductDuplicateData {
  productDuplicate: { newProduct: { id: string } | null; userErrors: UserError[] };
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

/** The shape auto-crop frames a product's photos in (CAT-21, ADR-503). */
export type ImageAspectRatio = 'SQUARE' | 'PORTRAIT_4_5' | 'PORTRAIT_3_4' | 'LANDSCAPE_4_3';

export interface ProductAutoCropMediaData {
  productAutoCropMedia: {
    croppedMediaIds: string[] | null;
    skipped:
      { mediaId: string; reason: 'BUSY_BACKGROUND' | 'NO_SUBJECT' | 'NOT_A_READY_IMAGE' }[] | null;
    userErrors: UserError[];
  };
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
  accountId: string;
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

/** Where a courier's name for a city came from (SHP-03). */
export type CourierCitySource = 'SHOP' | 'PLATFORM' | 'SHOPS' | 'LIST' | 'WRITTEN';

/** How a city matches a courier's names: its name for it, or the nearest where it has none. */
export interface CourierCityMatchValue {
  city: string;
  courierCity: string | null;
  source: CourierCitySource | null;
  suggestions: string[];
  listError: string | null;
}

export interface OrderCityData {
  order: { id: string; name: string; shippingAddress: { city: string } | null } | null;
}

export interface CourierCityMatchData {
  courierCityMatch: CourierCityMatchValue;
}

export interface CourierCityNamesData {
  courierAccounts: { id: string; name: string; courierName: string }[];
  courierCityNames: { city: string; courierCity: string; updatedAt: string }[];
}

export interface CourierCityNameSetData {
  courierCityNameSet: { match: CourierCityMatchValue | null; userErrors: UserError[] };
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
  byHand: boolean;
  parcelCount: number;
  handedOverCount: number;
  reference: string | null;
  loadSheetUrl: string | null;
  error: string | null;
  riderName: string | null;
  riderCode: string | null;
  createdAt: string;
  requestedAt: string | null;
}

export interface PickupParcel {
  booking: {
    id: string;
    orderId: string;
    orderName: string;
    trackingNumber: string | null;
    /** What the courier's tracking says of it; BOOKED until the courier has it. */
    parcelStatus: string | null;
  };
  handedOverAt: string | null;
}

export interface CourierParcelsUnseenData {
  shop: { timezone: string };
  courierParcelsUnseen: {
    booking: {
      id: string;
      orderId: string;
      orderName: string;
      trackingNumber: string | null;
      courierName: string;
    };
    handedOverAt: string;
    pickupId: string;
    riderName: string | null;
    riderCode: string | null;
  }[];
}

export interface CourierPickupParcelsData {
  courierPickup: {
    id: string;
    parcelCount: number;
    handedOverCount: number;
    parcels: PickupParcel[];
  } | null;
}

export interface CourierPickupParcelHandOverData {
  courierPickupParcelHandOver: {
    parcel: {
      booking: { id: string; orderName: string; trackingNumber: string | null };
      handedOverAt: string | null;
    } | null;
    alreadyHandedOver: boolean;
    userErrors: UserError[];
  };
}

export interface CourierPickupRecordByHandData {
  courierPickupRecordByHand: { courierPickup: CourierPickup | null; userErrors: UserError[] };
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
  /** Only whether the shop has any (ADR-382). */
  courierRules: { id: string }[];
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
export type OrderDocumentKind = 'PACKING_SLIP' | 'INVOICE' | 'CREDIT_NOTE';

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
  /** When a collaborator's access ends; none for staff kept for good (ADR-487). */
  expiresAt: string | null;
}

export interface StaffInvitation {
  id: string;
  role: StaffMemberRole;
  note: string | null;
  email: string | null;
  invitedBy: string;
  expiresAt: string;
  accessDays: number | null;
}

export type MetafieldOwnerTypeValue = 'PRODUCT' | 'PRODUCTVARIANT' | 'COLLECTION';

export type MetafieldTypeValue =
  | 'single_line_text_field'
  | 'multi_line_text_field'
  | 'number_integer'
  | 'number_decimal'
  | 'boolean'
  | 'date'
  | 'date_time'
  | 'url'
  | 'color'
  | 'json'
  | 'list.single_line_text_field';

/** A field of the shop's own (CAT-06, ADR-489). */
export interface MetafieldDefinition {
  id: string;
  ownerType: MetafieldOwnerTypeValue;
  namespace: string;
  key: string;
  type: MetafieldTypeValue;
  name: string;
  description: string | null;
  metafieldsCount: number;
}

export interface MetafieldDefinitionsData {
  metafieldDefinitions: MetafieldDefinition[];
}

export interface ProductMetafieldsData {
  metafieldDefinitions: MetafieldDefinition[];
  product: {
    id: string;
    metafields: { namespace: string; key: string; type: string; value: string }[];
  } | null;
}

/** An account asking to work in the shop for some days (ADR-488). */
export interface StaffAccessRequest {
  id: string;
  name: string;
  email: string | null;
  role: StaffMemberRole;
  accessDays: number;
  message: string | null;
  createdAt: string;
  expiresAt: string;
}

export interface StaffAccessRequestsData {
  staffAccessRequests: StaffAccessRequest[];
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
  onlinePaymentSettings: OnlinePaymentSettingsValue;
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
  customApps: boolean;
  automations: boolean;
  loyalty: boolean;
  conversionsApi: boolean;
  removeBranding: boolean;
  /** Whether its sales report gives true profit (ADR-529). */
  trueProfit: boolean;
  /** Whether its storefront may load the Meta pixel (ADR-531). */
  pixels: boolean;
  /** AI credits it includes a month (ADR-533). */
  aiCredits: number;
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
  /** Provincial sales tax in the amount (BIL-02); nothing where Hatti charges none. */
  tax: MoneyValue;
  taxRate: number;
  taxAuthority: string | null;
  plan: { name: string } | null;
  transfers: {
    id: string;
    reference: string;
    status: 'CONFIRMED' | 'REFUSED' | 'WAITING';
    refusal: string | null;
    reportedAt: string;
  }[];
}

export type BillingWalletEntryKind =
  'AI_CREDITS' | 'GRANT' | 'MESSAGE' | 'MESSAGE_REFUND' | 'TOP_UP';

/** A change to the shop's message credit: bought, given, or taken for a message (BIL-03). */
export interface BillingWalletEntryValue {
  id: string;
  kind: BillingWalletEntryKind;
  amount: MoneyValue;
  balance: MoneyValue;
  channel: MessageChannel | null;
  category: 'AUTHENTICATION' | 'MARKETING' | 'UTILITY' | null;
  parts: number | null;
  note: string | null;
  createdAt: string;
}

export interface BillingWalletEntriesData {
  billingWalletEntries: BillingWalletEntryValue[];
}

/** The shop's AI credits: the month's own and those it bought (ADR-539). */
export interface BillingAiCreditsValue {
  perMonth: number;
  used: number;
  bought: number;
  left: number;
  renewsAt: string;
  packCredits: number;
  packPrice: MoneyValue;
}

export interface BillingData {
  billingSubscription: {
    plan: BillingPlanValue;
    interval: BillingInterval | null;
    periodEnd: string | null;
    pastDue: boolean;
    /** When an overdue shop is on Free unless its invoice is paid (BIL-04). */
    freeAt: string | null;
    nextPlan: { name: string } | null;
    openInvoice: BillingInvoiceValue | null;
  };
  billingPlans: BillingPlanValue[];
  billingWallet: { balance: MoneyValue; openInvoice: BillingInvoiceValue | null };
  /** The month's AI credits and those bought (ADR-533, ADR-539); missing from older answers. */
  billingAiCredits?: BillingAiCreditsValue;
  billingInvoices: BillingInvoiceValue[];
  billingBankAccount: {
    bankName: string;
    title: string;
    iban: string;
    raastId: string | null;
  } | null;
}

export type DiscountCodeKind = 'PERCENTAGE' | 'FIXED_AMOUNT' | 'FREE_SHIPPING' | 'BUY_X_GET_Y';

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

/** A discount given without a code to every order that qualifies (ADR-515). */
export interface AutomaticDiscountValue {
  id: string;
  title: string;
  kind: DiscountCodeKind;
  summary: string;
  status: 'ACTIVE' | 'SCHEDULED' | 'EXPIRED';
  combinesWithCodes: boolean;
  startsAt: string;
  endsAt: string | null;
}

export interface AutomaticDiscountsData {
  automaticDiscounts: AutomaticDiscountValue[];
}

export interface AutomaticDiscountPayloadData {
  automaticDiscount: AutomaticDiscountValue | null;
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
  shippingAddress: {
    formatted: string[];
    name: string | null;
    phone: string | null;
    city: string;
    address1: string | null;
    address2: string | null;
    landmark: string | null;
    province: string | null;
    zip: string | null;
    latitude: number | null;
    longitude: number | null;
  } | null;
  subtotalPrice: MoneyValue;
  totalShippingPrice: MoneyValue;
  totalDiscounts: MoneyValue;
  /** The shop's code that set totalDiscounts (ADR-521). */
  discountCode: string | null;
  totalPrice: MoneyValue;
  codAmount: MoneyValue;
  deliveryMethod: OrderDeliveryMethod;
  /** Where it ships from, or is picked up; null for one chosen when it is placed. */
  location: { id: string; name: string } | null;
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
  grossProfit?: MoneyValue;
  /** Null on a plan without true profit (ADR-529). */
  profit: MoneyValue | null;
  /** Of couriers' charges in profit, what rate cards estimate, no statement saying (ADR-383). */
  shippingCostsEstimated?: MoneyValue | null;
}

export interface SalesData {
  salesReport: {
    totals: SalesTotalsValue;
    previous: { totals: SalesTotalsValue };
    periods: { start: string; sales: { orders: number; netSales: MoneyValue } }[];
    topProducts: { productId: string; title: string; unitsSold: number; grossSales: MoneyValue }[];
    rows: { key: string | null; title: string; sales: { orders: number; netSales: MoneyValue } }[];
    /** Whether the shop's plan includes true profit (ADR-529); without it, profit is null. */
    trueProfit?: boolean;
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

/** How a courier's parcels went, everywhere or in one city (SHP-08). */
export interface CourierTallyValue {
  shipped: number;
  delivered: number;
  returned: number;
  lost: number;
  inTransit: number;
  deliveryRate: number | null;
  returnRate: number | null;
  daysToDeliver: number | null;
  chargePerParcel: MoneyValue | null;
}

export interface CourierPerformanceData {
  courierPerformance: (CourierTallyValue & {
    /** Null for parcels without a courier named. */
    courier: string | null;
    title: string;
    chargesEstimated: MoneyValue;
    cities: (CourierTallyValue & { city: string })[];
  })[];
}

/** An agent of the Confirmation Desk over a period: a member of staff, or an app by its token. */
export interface ConfirmationAgentValue {
  id: string;
  kind: 'STAFF' | 'APP';
  confirmed: number;
  cancelled: number;
  confirmationRate: number | null;
  confirmationsPerHour: number | null;
  activeHours: number;
  calls: { noAnswer: number; callBack: number; wrongNumber: number };
  delivery: CodDeliveryFigures;
}

export interface PackerValue {
  id: string;
  kind: 'STAFF' | 'APP';
  packed: number;
  units: number;
  activeHours: number;
  packedPerHour: number | null;
}

/** Packers' counts; the staff's names only for those who see every packer. */
export interface PackersData {
  packers: PackerValue[];
  staffMembers?: { id: string; name: string }[];
}

export interface ConfirmationAgentsData {
  confirmationAgents: ConfirmationAgentValue[];
  staffMembers: { id: string; name: string }[];
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

export interface PaymentSettlementSummary {
  id: string;
  accountId: string;
  gateway: string;
  gatewayName: string;
  reference: string | null;
  createdAt: string;
  lineCount: number;
  issueCount: number;
  gross: MoneyValue;
  fees: MoneyValue;
  tax: MoneyValue;
  net: MoneyValue;
}

export interface PaymentSettlementAccountValue {
  id: string;
  gateway: string;
  gatewayName: string;
  sandbox: boolean;
}

export interface PaymentSettlementsData {
  paymentSettlementAccounts: PaymentSettlementAccountValue[];
  paymentSettlements: PaymentSettlementSummary[];
}

export type PaymentSettlementOutcome = 'MATCHED' | 'DIFFERS' | 'UNMATCHED' | 'REPEATED' | 'REFUND';

export interface PaymentSettlementLineValue {
  row: number;
  transactionRef: string;
  orderId: string | null;
  outcome: PaymentSettlementOutcome;
  gross: MoneyValue;
  fees: MoneyValue;
  tax: MoneyValue;
  paid: MoneyValue | null;
}

export interface PaymentSettlementData {
  paymentSettlement: (PaymentSettlementSummary & { lines: PaymentSettlementLineValue[] }) | null;
}

export type PaymentSettlementOutcomeCounts = Record<
  'matched' | 'differs' | 'unmatched' | 'repeated' | 'refund',
  number
>;

export interface PaymentSettlementImportData {
  paymentSettlementImport: {
    dryRun: boolean;
    rows: number;
    rowErrorCount: number;
    rowErrors: { row: number; column: string | null; message: string }[];
    outcomes: PaymentSettlementOutcomeCounts;
    gross: MoneyValue;
    fees: MoneyValue;
    tax: MoneyValue;
    net: MoneyValue;
    settlement: { id: string } | null;
    userErrors: UserError[];
  };
}

export interface PayoutTotalsValue {
  statements: number;
  gross: MoneyValue;
  fees: MoneyValue;
  tax: MoneyValue;
  net: MoneyValue;
}

export type PayoutSourceKind = 'GATEWAY' | 'COURIER';

export interface PayoutWithholdingValue {
  id: string;
  kind: PayoutSourceKind;
  name: string;
  reference: string | null;
  importedAt: string;
  gross: MoneyValue;
  fees: MoneyValue;
  tax: MoneyValue;
  net: MoneyValue;
}

export interface PayoutsReportData {
  payoutsReport: {
    totals: PayoutTotalsValue;
    sources: (PayoutTotalsValue & { kind: PayoutSourceKind; name: string })[];
    months: (PayoutTotalsValue & { month: string })[];
    withholdings: PayoutWithholdingValue[];
    truncated: boolean;
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

/** What a customer answered when told their delivery failed (ADR-388). */
export type DeliveryRescueAnswer = 'RETRY' | 'CALL';

export interface DeliveriesToRescueData {
  deliveriesToRescue: {
    count: number;
    parcels: (ParcelBase & {
      customerName: string | null;
      city: string | null;
      attemptedAt: string;
      reason: string | null;
      attempts: number;
      answer: DeliveryRescueAnswer | null;
      answeredAt: string | null;
    })[];
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
  home: {
    lowStock: { low: number; out: number; threshold: number };
    /** Transfers on their way to the location asked for, or anywhere (ADR-364). */
    transfersToReceive: number;
  };
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
      /** Units on open purchase orders, not yet received. */
      incoming: number;
      lastSupplier: { id: string; name: string } | null;
      lastUnitCost: { amount: string } | null;
      /** Units sold in the last 30 days: committed to orders, less those cancelled. */
      soldLast30Days: number;
      /** Whole days what is available lasts at that pace; null when none sold. */
      daysOfStockLeft: number | null;
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
        barcode: string | null;
        inventoryQuantity: number;
        inventoryItem: { id: string; tracked: boolean };
      }[];
    }[];
  };
}

export interface StockCountFindData {
  products: {
    nodes: {
      id: string;
      title: string;
      variants: {
        id: string;
        title: string;
        sku: string | null;
        barcode: string | null;
        inventoryItem: { id: string; inventoryLevel: { onHand: number } | null };
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
    changes: StockChangePage;
  } | null;
}

/** A change to a variant's stock: by how much, which quantity, why, and what it was for. */
export interface StockChange {
  createdAt: string;
  delta: number;
  name: string;
  reason: string;
  quantityAfterChange: number;
  /** What it was for, as `hatti://orders/ord_…` for an order's. */
  referenceDocumentUri: string | null;
  location: { id: string; name: string };
}

export interface StockChangePage {
  nodes: StockChange[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

export interface InventoryChangesData {
  inventoryItem: { id: string; changes: StockChangePage } | null;
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

export type VerificationLevel = 'IDENTITY' | 'BUSINESS';
export type VerificationStatus = 'WAITING' | 'APPROVED' | 'REFUSED' | 'REVOKED';

export interface VerificationRequest {
  id: string;
  level: VerificationLevel;
  name: string;
  cnicLast4: string | null;
  ntn: string | null;
  status: VerificationStatus;
  createdAt: string;
  decidedAt: string | null;
  answer: string | null;
}

export type SmsSenderStatus =
  'WAITING' | 'APPROVED' | 'REFUSED' | 'WITHDRAWN' | 'REPLACED' | 'REVOKED';

/** A request for the shop's SMS to go from a name of its own (ADR-469). */
export interface SmsSenderRequest {
  id: string;
  name: string;
  status: SmsSenderStatus;
  createdAt: string;
  decidedAt: string | null;
  answer: string | null;
}

export interface SmsSenderData {
  smsSender: { name: string | null; requests: SmsSenderRequest[] };
}

export interface SmsSenderRequestData {
  smsSenderRequest: {
    request: { id: string; status: SmsSenderStatus } | null;
    userErrors: UserError[];
  };
}

export interface SmsSenderWithdrawData {
  smsSenderWithdraw: {
    request: { id: string; status: SmsSenderStatus } | null;
    userErrors: UserError[];
  };
}

export interface ShopVerificationData {
  shopVerification: { level: VerificationLevel | null; requests: VerificationRequest[] };
}

export interface ShopVerificationSubmitData {
  shopVerificationSubmit: {
    request: { id: string; status: VerificationStatus } | null;
    userErrors: UserError[];
  };
}

export type CopyLanguage = 'ENGLISH' | 'URDU' | 'ROMAN_URDU';

/** What a shop sells, set up in one go (ONB-13, ADR-486). */
export type StarterKitValue = 'FASHION' | 'JEWELLERY' | 'BEAUTY' | 'ELECTRONICS' | 'GROCERY';

export interface StarterKitsData {
  starterKits: {
    kit: StarterKitValue;
    collections: { title: string; handle: string; tag: string | null }[];
    sizeCharts: string[];
  }[];
}

/** What applying a kit made, and what the shop had already. */
export interface StarterKitApplied {
  collectionsMade: number;
  collectionsKept: number;
  sizeChartsMade: number;
  menuLinksAdded: number;
}

export interface StarterKitApplyData {
  starterKitApply: StarterKitApplied;
}

/** A measurement of how fast a page was for a shopper (ADR-485). */
export type WebVitalValue = 'LCP' | 'INP' | 'CLS' | 'FCP' | 'TTFB';

/** Google's rating of a measurement's 75th percentile. */
export type VitalRatingValue = 'GOOD' | 'NEEDS_IMPROVEMENT' | 'POOR';

export type SpeedDeviceValue = 'MOBILE' | 'DESKTOP';

/** A kind of the online store's pages, by its theme's template. */
export type StorefrontPageKindValue =
  'INDEX' | 'PRODUCT' | 'COLLECTION' | 'SEARCH' | 'CART' | 'PAGE' | 'BLOG' | 'ARTICLE' | 'OTHER';

export type SpeedFixValue =
  'HEAVY_FIRST_IMAGE' | 'LAYOUT_SHIFTS' | 'SLOW_TAPS' | 'SLOW_FIRST_PAINT' | 'SLOW_SERVER';

/** What shoppers' browsers measured of one metric: milliseconds, or unitless layout shift. */
export interface SpeedMetricValue {
  metric: WebVitalValue;
  samples: number;
  p75: number | null;
  over: boolean;
  good: number;
  rating: VitalRatingValue | null;
}

/** How fast the online store was over 28 days (OS-13, ADR-485). */
export interface StoreSpeedData {
  storeSpeed: {
    pageViews: number;
    devices: {
      device: SpeedDeviceValue;
      pageViews: number;
      score: number | null;
      metrics: SpeedMetricValue[];
    }[];
    fixes: {
      fix: SpeedFixValue;
      device: SpeedDeviceValue;
      kind: StorefrontPageKindValue | null;
      metric: WebVitalValue;
      rating: VitalRatingValue;
    }[];
  };
}

/** A moment Pakistani shoppers buy for (MKT-16, ADR-484). */
export type MarketingMomentValue =
  | 'RAMADAN'
  | 'EID_UL_FITR'
  | 'EID_UL_ADHA'
  | 'PAKISTAN_DAY'
  | 'MOTHERS_DAY'
  | 'INDEPENDENCE_DAY'
  | 'ELEVEN_ELEVEN'
  | 'WHITE_FRIDAY'
  | 'TWELVE_TWELVE'
  | 'SUMMER_LAWN'
  | 'WINTER_COLLECTION'
  | 'WEDDING_SEASON';

/** A moment's dates in a year, YYYY-MM-DD, with its ready-made campaign (ADR-484). */
export interface MarketingDateValue {
  moment: MarketingMomentValue;
  startsOn: string;
  endsOn: string;
  promoteFrom: string;
  expected: boolean;
  kit: { code: string; percentage: number; messageEnglish: string; messageUrdu: string };
}

export interface MarketingCalendarData {
  marketingCalendar: MarketingDateValue[];
}

/** Whether a product is new, refurbished or used (ADR-483). */
export type ProductConditionValue = 'NEW' | 'REFURBISHED' | 'USED';

/** The categories of Google's taxonomy a product may be given (ADR-483). */
export interface ProductCategoriesData {
  productCategories: string[];
}

export interface ProductCopyDraftingData {
  productCopyDrafting: {
    available: boolean;
    usedToday: number;
    limitPerDay: number;
    /** The plan's AI credits left this month, and its month's (ADR-533); null where uncounted. */
    creditsLeft?: number | null;
    creditsPerMonth?: number | null;
  };
}

export interface ProductCopyDraftData {
  productCopyDraft: {
    draft: {
      title: string;
      descriptionHtml: string;
      seoTitle: string;
      seoDescription: string;
    } | null;
    userErrors: UserError[];
  };
}

export interface TranslationDraftingData {
  translationDrafting: {
    available: boolean;
    usedToday: number;
    limitPerDay: number;
    /** The plan's AI credits left this month, and its month's (ADR-533); null where uncounted. */
    creditsLeft?: number | null;
    creditsPerMonth?: number | null;
  };
}

export interface TranslationsDraftData {
  translationsDraft: {
    drafts: { key: string; value: string; translatableContentDigest: string }[] | null;
    userErrors: UserError[];
  };
}

export interface InUrduData {
  translatableResourcesByIds: { nodes: UrduResource[] };
}

/** The kinds of the shop's things whose words are put in Urdu, each on its own Urdu page. */
export type UrduKind =
  | 'PRODUCT'
  | 'COLLECTION'
  | 'ONLINE_STORE_PAGE'
  | 'ONLINE_STORE_BLOG'
  | 'ONLINE_STORE_ARTICLE'
  | 'MENU'
  | 'SHOP';

export interface UrduOverviewData {
  translatableResources: { nodes: UrduResource[]; pageInfo: { hasNextPage: boolean } };
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
  /** Days a buyer has to return an order, null while the shop says nothing (ADR-468). */
  returnDays: number | null;
  returnExchangesOnly: boolean;
  hidePoweredBy: boolean;
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

export interface UrlRedirectUpdateData {
  urlRedirectUpdate: { urlRedirect: UrlRedirectValue | null; userErrors: UserError[] };
}

/** The product types and vendors a shop uses, to suggest as products are written. */
export interface ProductSuggestionsData {
  productTypes: string[];
  productVendors: string[];
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

export type PaymentSessionStatus = 'OPEN' | 'PAID' | 'FAILED';
export type PaymentRefundStatus = 'PENDING' | 'REFUNDED' | 'REFUSED' | 'UNKNOWN';

/** A refund asked of the gateway for an online payment. */
export interface PaymentRefundValue {
  id: string;
  status: PaymentRefundStatus;
  reference: string | null;
  error: string | null;
  createdAt: string;
  amount: MoneyValue;
}

/** A payment an order's customer started online, through the shop's gateway account. */
export interface PaymentSessionValue {
  id: string;
  gatewayName: string;
  environment: 'PRODUCTION' | 'SANDBOX';
  status: PaymentSessionStatus;
  method: string | null;
  reference: string | null;
  error: string | null;
  createdAt: string;
  paidAt: string | null;
  amount: MoneyValue;
  paidAmount: MoneyValue | null;
  applied: MoneyValue | null;
  refunds: PaymentRefundValue[];
}

export interface PaymentRefundSettleData {
  paymentRefundSettle: {
    paymentRefund: { id: string; status: PaymentRefundStatus; reference: string | null } | null;
    userErrors: UserError[];
  };
}

/** What checkout takes off orders paid online (PAY-05, CHK-08). */
export interface OnlinePaymentSettingsValue {
  updatedAt: string | null;
  discount: {
    kind: 'PERCENTAGE' | 'FIXED_AMOUNT';
    percentage: number | null;
    cap: MoneyValue | null;
    amount: MoneyValue | null;
  } | null;
}

export interface OnlinePaymentSettingsUpdateData {
  onlinePaymentSettingsUpdate: {
    onlinePaymentSettings: OnlinePaymentSettingsValue | null;
    userErrors: UserError[];
  };
}

export interface OrderCreateManualPaymentData {
  orderCreateManualPayment: {
    order: { id: string; stage: OrderStage; amountPaid: MoneyValue } | null;
    userErrors: UserError[];
  };
}

export interface OrderLinkCreateData {
  orderLinkCreate: {
    url: string | null;
    whatsappUrl: string | null;
    order: { id: string; customerLink: { expiresAt: string | null } | null } | null;
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

export type TaxProvince =
  | 'PUNJAB'
  | 'SINDH'
  | 'KHYBER_PAKHTUNKHWA'
  | 'BALOCHISTAN'
  | 'ISLAMABAD'
  | 'GILGIT_BALTISTAN'
  | 'AZAD_KASHMIR';

export type FilerStatus = 'ACTIVE' | 'INACTIVE' | 'UNKNOWN';

export type TaxGuidanceCode =
  | 'REGISTER_NTN'
  | 'REGISTER_SALES_TAX'
  | 'JOIN_ACTIVE_TAXPAYERS'
  | 'NAME_PROVINCE'
  | 'DIGITAL_INVOICING'
  | 'TIER1_RETURNS';

export interface TaxSettings {
  rate: number | null;
  taxDelivery: boolean;
  ntn: string | null;
  strn: string | null;
  /** The shop's tax profile (ONB-12, ADR-500). */
  province: TaxProvince | null;
  filerStatus: FilerStatus;
  tier1: boolean;
  withholding: { digitalPercent: number; cashOnDeliveryPercent: number };
  guidance: { code: TaxGuidanceCode; status: 'DONE' | 'TO_DO' | 'NOTE' }[];
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
  /** Null with the pixel alone, without the conversions API (ADR-531). */
  accessTokenHint: string | null;
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
  /**
   * The offer after the purchase's percentage off (ADR-438); null for no offer, absent where a
   * fake core leaves it out.
   */
  upsellPercentOff?: number | null;
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
  checkoutRecoverySettings: CheckoutRecoverySettings;
  /** The shop's codes, of which it may offer one after the reminder (ADR-426). */
  discountCodes?: {
    nodes: Pick<DiscountCodeValue, 'id' | 'code' | 'kind' | 'summary' | 'status'>[];
  };
  /** Gift wrap and messages (ADR-413); absent where a fake core leaves it out. */
  checkoutGiftOptions?: CheckoutGiftOptions;
}

/** What checkout offers to send a gift with (CHK-16, ADR-413). */
export interface CheckoutGiftOptions {
  wrap: {
    variantId: string;
    productTitle: string;
    variantTitle: string;
    price: MoneyValue;
    forSale: boolean;
  } | null;
  messages: boolean;
}

export interface CheckoutGiftOptionsUpdateData {
  checkoutGiftOptionsUpdate: {
    checkoutGiftOptions: CheckoutGiftOptions | null;
    userErrors: UserError[];
  };
}

/**
 * Whether, and how long after they leave, the shop reminds shoppers (ADR-393); and the code it
 * offers them some hours after (ADR-426).
 */
export interface CheckoutRecoverySettings {
  reminderAfterMinutes: number | null;
  /** 12, 24 or 48; absent where a fake core leaves it out. */
  offerAfterHours?: number | null;
  offerDiscountCode?: { id: string; code: string; summary?: string } | null;
}

export interface CheckoutRecoverySettingsUpdateData {
  checkoutRecoverySettingsUpdate: {
    checkoutRecoverySettings: CheckoutRecoverySettings | null;
    userErrors: UserError[];
  };
}

/** A checkout its shopper left after typing their number (CHK-12, ADR-393). */
export interface AbandonedCheckout {
  id: string;
  createdAt: string;
  abandonedAt: string;
  name: string | null;
  /** In E.164, or masked for roles that see numbers masked. */
  phone: string;
  lineItems: { variantId: string; title: string; variantTitle: string; quantity: number }[];
  subtotalPrice: MoneyValue;
  remindedAt: string | null;
  /** When they were offered a code after the reminder, and which (ADR-426). */
  offeredAt?: string | null;
  offerCode?: string | null;
  recoveredOrder: { id: string; name: string } | null;
}

export interface AbandonedCheckoutsData {
  abandonedCheckouts: AbandonedCheckout[];
  checkoutRecoverySettings: CheckoutRecoverySettings;
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
  locations: {
    nodes: {
      id: string;
      name: string;
      isPrimary: boolean;
      /** Set where customers may pick orders up (ADR-389). */
      localPickupSettings?: { instructions: string | null } | null;
    }[];
  };
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
  /** Customers may collect their orders here (ADR-389); null where they may not. */
  localPickupSettings: { instructions: string | null } | null;
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
  locationMakePrimary?: { location: ShopLocation | null; userErrors: UserError[] };
  locationLocalPickupEnable?: { location: ShopLocation | null; userErrors: UserError[] };
  locationLocalPickupDisable?: { location: ShopLocation | null; userErrors: UserError[] };
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

export type PurchaseOrderStatus = 'OPEN' | 'RECEIVED' | 'CLOSED';

export interface PurchaseOrderLine {
  id: string;
  productTitle: string;
  variantTitle: string;
  sku: string | null;
  quantity: number;
  received: number;
  unitCost: MoneyValue | null;
  inventoryItem: { id: string };
}

export interface PurchaseOrder {
  id: string;
  name: string;
  status: PurchaseOrderStatus;
  reference: string | null;
  note: string | null;
  expectedOn: string | null;
  totalQuantity: number;
  receivedQuantity: number;
  totalCost: MoneyValue | null;
  supplier: { id: string; name: string; phone: string | null };
  location: { id: string; name: string };
  closedAt: string | null;
  createdAt: string;
  lines: PurchaseOrderLine[];
}

export interface PurchaseOrdersData {
  purchaseOrders: {
    nodes: (Pick<
      PurchaseOrder,
      'id' | 'name' | 'status' | 'expectedOn' | 'totalQuantity' | 'receivedQuantity' | 'createdAt'
    > & { supplier: { name: string }; location: { name: string } })[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

export interface PurchaseOrderData {
  purchaseOrder: PurchaseOrder | null;
}

export interface PurchaseOrderFormData {
  suppliers: { id: string; name: string; phone: string | null }[];
  locations: { nodes: { id: string; name: string; isPrimary: boolean }[] };
}

export interface Supplier {
  id: string;
  name: string;
  phone: string | null;
  note: string | null;
}

/** What the shop has bought from a supplier, and still waits for (ADR-371). */
export interface SupplierPurchasing {
  purchaseOrders: number;
  receivedQuantity: number;
  /** What the units received cost, where a cost was given. */
  receivedCost: { amount: string };
  /** Units on open purchase orders, not yet received. */
  awaitingQuantity: number;
  awaitingCost: { amount: string };
  lastOrderedAt: string | null;
}

export interface SuppliersData {
  suppliers: (Supplier & { purchasing: SupplierPurchasing })[];
}

export interface PurchaseOrderDocumentData {
  purchaseOrderDocument: { html: string; title: string; fileName: string } | null;
}

export type InventoryTransferStatus = 'IN_TRANSIT' | 'RECEIVED' | 'CANCELLED' | 'CLOSED';

export interface InventoryTransfer {
  id: string;
  name: string;
  status: InventoryTransferStatus;
  reference: string | null;
  note: string | null;
  totalQuantity: number;
  receivedQuantity: number;
  /** What had not arrived when it was closed (ADR-366). */
  lostQuantity: number;
  origin: { id: string; name: string };
  destination: { id: string; name: string };
  closedAt: string | null;
  createdAt: string;
  lines: {
    id: string;
    productTitle: string;
    variantTitle: string;
    sku: string | null;
    quantity: number;
    received: number;
    inventoryItem: { id: string };
  }[];
}

export interface InventoryTransfersData {
  inventoryTransfers: {
    nodes: (Pick<
      InventoryTransfer,
      'id' | 'name' | 'status' | 'totalQuantity' | 'receivedQuantity' | 'createdAt'
    > & { origin: { name: string }; destination: { name: string } })[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

export interface InventoryTransferData {
  inventoryTransfer: InventoryTransfer | null;
}

export interface LowStockToSendData {
  inventorySettings: { lowStockThreshold: number };
  inventoryLowStock: {
    nodes: {
      variantId: string;
      variantTitle: string;
      productTitle: string;
      available: number;
      incoming: number;
      inventoryItem: {
        id: string;
        inventoryLevels: { available: number; location: { id: string } }[];
      };
    }[];
  };
}

export interface InventoryTransferDocumentData {
  inventoryTransferDocument: { html: string; title: string; fileName: string } | null;
}

/** What the stock on hand is worth at cost (ADR-369). */
export interface InventoryValueData {
  inventoryValue: {
    units: number;
    /** Units of variants with no cost: not in the value. */
    unitsWithoutCost: number;
    value: { amount: string };
    /** The most first. */
    locations: {
      location: { id: string; name: string };
      units: number;
      unitsWithoutCost: number;
      value: { amount: string };
    }[];
  };
}

export type InventoryReportSortKey = 'SELL_THROUGH' | 'SLOWEST' | 'STOCKOUTS';
export type InventoryAgeingBucket = 'DAYS_0_30' | 'DAYS_31_60' | 'DAYS_61_90' | 'OVER_90' | 'NEVER';

/** One variant in the inventory report (ANL-05, ADR-455). */
export interface InventoryReportRowValue {
  variantId: string;
  productId: string;
  productTitle: string;
  variantTitle: string;
  sku: string | null;
  /** Units sold in the period, less those released. */
  sold: number;
  available: number;
  /** In percent; null with neither sold nor available. */
  sellThrough: number | null;
  /** Null when it never sold. */
  daysSinceSale: number | null;
  stockouts: number;
  /** At the location it was out longest, to one decimal. */
  daysOut: number;
}

/** What sold of what there was, how old the stock is, and what ran out (ANL-05, ADR-455). */
export interface InventoryReportData {
  inventoryReport: {
    days: number;
    sold: number;
    onHand: number;
    sellThrough: number | null;
    ranOut: number;
    outNow: number;
    ageing: {
      bucket: InventoryAgeingBucket;
      variants: number;
      units: number;
      unitsWithoutCost: number;
      value: { amount: string };
    }[];
    rows: InventoryReportRowValue[];
  };
}

/** Which courier account books the orders a rule matches (SHP-06, ADR-382). */
export interface CourierRuleValue {
  id: string;
  /** Null for one of the shop's accounts picked by their rate cards (ADR-385). */
  accountId: string | null;
  /** How it is picked where the rule names none (ADR-387). */
  pick: 'CHEAPEST' | 'BEST_VALUE' | null;
  accountArchived: boolean;
  /** Cities as Pakistan's list names them; none for anywhere. */
  cities: string[];
  codAtLeast: MoneyValue | null;
  codBelow: MoneyValue | null;
}

export interface CourierRulesData {
  courierRules: CourierRuleValue[];
}

export interface CourierRulesUpdateData {
  courierRulesUpdate: { courierRules: CourierRuleValue[] | null; userErrors: UserError[] };
}

export interface CourierAccountsForData {
  courierAccountsFor: {
    orderId: string;
    accountId: string | null;
    ruleId: string | null;
    /** Out and the cash fee by the account's rate card (ADR-383); null without one. */
    chargeEstimate: MoneyValue | null;
  }[];
}

/** What a courier account charges (SHP-07, ADR-383). */
export interface CourierRateCardValue {
  accountId: string;
  originCity: string;
  localFirst: MoneyValue;
  localEach: MoneyValue;
  otherFirst: MoneyValue;
  otherEach: MoneyValue;
  codFeePercent: number;
  returnPercent: number;
  updatedAt: string;
}

export interface CourierRateCardsData {
  courierAccounts: { id: string; name: string; courierName: string }[];
  courierRateCards: CourierRateCardValue[];
}

export interface CourierRateCardSetData {
  courierRateCardSet: { courierRateCard: CourierRateCardValue | null; userErrors: UserError[] };
}

export interface CourierRateCardRemoveData {
  courierRateCardRemove: { removed: boolean; userErrors: UserError[] };
}

/** One of the shop's custom apps (DEV-04, ADR-395): never its token or secret. */
export interface CustomApp {
  id: string;
  name: string;
  scopes: string[];
  tokenHint: string;
  secretHint: string | null;
  createdAt: string;
}

export interface CustomAppsData {
  customApps: CustomApp[];
}

export interface CustomAppInput {
  name?: string | null;
  scopes?: string[] | null;
}

export interface CustomAppCreateData {
  customAppCreate: {
    customApp: CustomApp | null;
    accessToken: string | null;
    webhookSecret: string | null;
    userErrors: UserError[];
  };
}

export interface CustomAppUpdateData {
  customAppUpdate: { customApp: CustomApp | null; userErrors: UserError[] };
}

export interface CustomAppTokenRotateData {
  customAppTokenRotate: {
    customApp: CustomApp | null;
    accessToken: string | null;
    userErrors: UserError[];
  };
}

export interface CustomAppSecretRotateData {
  customAppSecretRotate: {
    customApp: CustomApp | null;
    webhookSecret: string | null;
    userErrors: UserError[];
  };
}

export interface CustomAppDeleteData {
  customAppDelete: { deletedCustomAppId: string | null; userErrors: UserError[] };
}

export type WebhookTopic =
  | 'ORDERS_CREATE'
  | 'ORDERS_UPDATED'
  | 'ORDERS_CANCELLED'
  | 'ORDERS_PAID'
  | 'FULFILLMENTS_CREATE'
  | 'FULFILLMENTS_UPDATE'
  | 'PRODUCTS_CREATE'
  | 'PRODUCTS_UPDATE'
  | 'PRODUCTS_DELETE'
  | 'INVENTORY_LEVELS_UPDATE'
  | 'CUSTOMERS_CREATE'
  | 'CUSTOMERS_UPDATE'
  | 'APP_UNINSTALLED';

/** One event's post to an app (ADR-397). */
export interface WebhookDelivery {
  id: string;
  status: 'PENDING' | 'DELIVERED' | 'FAILED';
  attempts: number;
  responseStatus: number | null;
  error: string | null;
  createdAt: string;
  lastAttemptAt: string | null;
  nextAttemptAt: string | null;
}

export interface WebhookSubscription {
  id: string;
  topic: WebhookTopic;
  callbackUrl: string;
  appId: string;
  createdAt: string;
  lastDelivery: WebhookDelivery | null;
}

export interface WebhookSubscriptionsData {
  webhookSubscriptions: WebhookSubscription[];
}

export interface WebhookDeliveriesData {
  webhookDeliveries: WebhookDelivery[];
}

export interface WebhookSubscriptionCreateData {
  webhookSubscriptionCreate: {
    webhookSubscription: { id: string } | null;
    userErrors: UserError[];
  };
}

export interface WebhookSubscriptionDeleteData {
  webhookSubscriptionDelete: {
    deletedWebhookSubscriptionId: string | null;
    userErrors: UserError[];
  };
}

export type ProductReviewStatus = 'PENDING' | 'PUBLISHED' | 'HIDDEN';

/** A customer's stars and words for a product of an order delivered to them (ADR-399). */
export interface ProductReview {
  id: string;
  productId: string;
  productTitle: string;
  orderId: string;
  /** "Ayesha K.", as the storefront shows it. */
  authorName: string;
  rating: number;
  body: string | null;
  status: ProductReviewStatus;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
}

export interface ProductReviewsData {
  productReviews: ProductReview[];
}

export interface ProductReviewPublishData {
  productReviewPublish: { productReview: ProductReview | null; userErrors: UserError[] };
}

export interface ProductReviewHideData {
  productReviewHide: { productReview: ProductReview | null; userErrors: UserError[] };
}

export interface ReviewSettings {
  /** 3, 4 or 5: reviews of as many stars publish by themselves; null, each waits. */
  publishFrom: number | null;
  /** 1 to 14 days after delivery customers are asked on WhatsApp; null, never. */
  requestAfterDays: number | null;
}

export interface ReviewSettingsData {
  reviewSettings: ReviewSettings;
}

export interface ReviewSettingsUpdateData {
  reviewSettingsUpdate: { reviewSettings: ReviewSettings | null; userErrors: UserError[] };
}

export interface ProductPreorderSetData {
  productPreorderSet: {
    preorder: { productId: string; shipsOn: string } | null;
    userErrors: UserError[];
  };
}

/** A part of a bundle: a variant of another product, and how many one set holds. */
export interface ProductBundleComponent {
  productId: string;
  variantId: string;
  productTitle: string;
  variantTitle: string;
  quantity: number;
}

/** A product sold as a set of other products' variants (CAT-11, ADR-409). */
export interface ProductBundle {
  /** False once a part's variant was deleted: it is not sold until it has its parts again. */
  complete: boolean;
  components: ProductBundleComponent[];
}

export interface ProductBundleSetData {
  productBundleSet: { bundle: ProductBundle | null; userErrors: UserError[] };
}

export type PriceSaleStatus = 'SCHEDULED' | 'RUNNING' | 'ENDED' | 'CANCELLED';

/** A sale set ahead (ADR-443). */
export interface PriceSale {
  id: string;
  name: string;
  percentOff: number;
  status: PriceSaleStatus;
  startsAt: string;
  endsAt: string;
  endedAt: string | null;
  productsCount: number;
  products: { id: string; title: string }[];
}

export interface PriceSalesData {
  priceSales: PriceSale[];
}

export interface PriceSaleCreateInput {
  name: string;
  percentOff: number;
  startsAt: string;
  endsAt: string;
  productIds: string[];
}

export interface PriceSaleCreateData {
  priceSaleCreate: { priceSale: PriceSale | null; userErrors: UserError[] };
}

export interface PriceSaleCancelData {
  priceSaleCancel: { priceSale: PriceSale | null; userErrors: UserError[] };
}

export interface ProductSchedulePublishData {
  productSchedulePublish: {
    product: { id: string; status: string; publishAt: string | null } | null;
    userErrors: UserError[];
  };
}

export interface ProductComplementsSetData {
  productComplementsSet: {
    complementaryProducts: { id: string; title: string }[] | null;
    userErrors: UserError[];
  };
}

export type SizeChartUnit = 'INCHES' | 'CENTIMETERS';

/** A table of measurements, a row for each size (CAT-10, ADR-406). */
export interface SizeChart {
  id: string;
  name: string;
  unit: SizeChartUnit;
  columns: string[];
  rows: { size: string; values: (number | null)[] }[];
  note: string | null;
  productsCount: number;
}

export interface SizeChartInput {
  name: string;
  unit: SizeChartUnit;
  columns: string[];
  rows: { size: string; values: (number | null)[] }[];
  note: string | null;
}

export interface SizeChartsData {
  sizeCharts: SizeChart[];
}

export interface SizeChartData {
  sizeChart: SizeChart | null;
}

export interface SizeChartCreateData {
  sizeChartCreate: { sizeChart: SizeChart | null; userErrors: UserError[] };
}

export interface SizeChartUpdateData {
  sizeChartUpdate: { sizeChart: SizeChart | null; userErrors: UserError[] };
}

export interface SizeChartDeleteData {
  sizeChartDelete: { deletedSizeChartId: string | null; userErrors: UserError[] };
}

export interface ProductsSizeChartSetData {
  productsSizeChartSet: { productIds: string[]; userErrors: UserError[] };
}

/** The whole store exported (ADM-10, ADR-415). */
export interface StoreExport {
  id: string;
  status: 'PENDING' | 'READY' | 'FAILED' | 'EXPIRED';
  /** Bytes of the ZIP, once ready. */
  size: number | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
  expiresAt: string | null;
  /** A link that downloads it for an hour, while ready. */
  url: string | null;
}

export interface StoreExportsData {
  storeExports: StoreExport[];
}

export interface StoreExportCreateData {
  storeExportCreate: { storeExport: StoreExport | null; userErrors: UserError[] };
}

export type WhatsAppQualityRating = 'GREEN' | 'YELLOW' | 'RED' | 'UNKNOWN';

/** The shop's own WhatsApp Business number (ADR-419). */
export interface WhatsAppAccount {
  businessAccountId: string;
  phoneNumberId: string;
  displayPhoneNumber: string;
  verifiedName: string;
  qualityRating: WhatsAppQualityRating;
  connectedAt: string;
}

/** What Meta's Embedded Signup starts with: Hatti's app, its configuration and Graph's version. */
export interface WhatsAppSignup {
  appId: string;
  configurationId: string;
  graphVersion: string;
}

/** How far Meta has come with Hatti's order templates on the shop's number (ADR-537). */
export interface WhatsAppOrderTemplates {
  total: number;
  approved: number;
  pending: number;
  refused: number;
  triedAt: string | null;
}

export interface WhatsAppAccountData {
  whatsAppAccount: WhatsAppAccount | null;
  whatsAppSignup: WhatsAppSignup | null;
  whatsAppOrderTemplates?: WhatsAppOrderTemplates | null;
}

export interface WhatsAppAccountConnectData {
  whatsAppAccountConnect: { whatsAppAccount: WhatsAppAccount | null; userErrors: UserError[] };
}

export interface WhatsAppAccountDisconnectData {
  whatsAppAccountDisconnect: { disconnectedPhoneNumber: string | null; userErrors: UserError[] };
}

export type WhatsAppTemplateStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'PAUSED' | 'DISABLED';

/** One of the shop's own marketing templates on its WhatsApp number (ADR-420). */
export interface WhatsAppTemplate {
  id: string;
  name: string;
  language: MessageLanguage;
  header: string | null;
  body: string;
  footer: string | null;
  buttonText: string | null;
  buttonUrl: string | null;
  status: WhatsAppTemplateStatus;
  rejectedReason: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One of the shop's automations' recipes (MKT-04, ADR-425). */
export type MarketingAutomationKind =
  'WELCOME' | 'WIN_BACK' | 'BACK_IN_STOCK' | 'COD_PREPAID' | 'CASHBACK';

/** A template as an automation names it. */
export type AutomationTemplate = Pick<WhatsAppTemplate, 'id' | 'name' | 'language' | 'status'>;

export interface MarketingAutomation {
  kind: MarketingAutomationKind;
  enabled: boolean;
  /** For a win-back: how many days after the customer's last order. */
  afterDays: number | null;
  /** For COD to prepaid: the store credit it offers (ADR-432). */
  creditAmount: MoneyValue | null;
  /** For cashback: the share of an order's goods given back (ADR-453); absent from a fake core. */
  cashbackPercent?: number | null;
  /** For cashback: how many days its store credit lasts; absent from a fake core. */
  creditDays?: number | null;
  updatedAt: string | null;
  template: AutomationTemplate | null;
}

export interface MarketingAutomationsData {
  marketingAutomations: MarketingAutomation[];
  whatsAppTemplates: AutomationTemplate[];
}

export interface MarketingAutomationUpdateData {
  marketingAutomationUpdate: {
    marketingAutomation: MarketingAutomation | null;
    userErrors: UserError[];
  };
}

export interface WhatsAppTemplateInput {
  name: string;
  language: MessageLanguage;
  body: string;
  header?: string | null;
  footer?: string | null;
  buttonText?: string | null;
  buttonUrl?: string | null;
}

export interface WhatsAppTemplatesData {
  whatsAppTemplates: WhatsAppTemplate[];
}

export interface WhatsAppTemplateCreateData {
  whatsAppTemplateCreate: { whatsAppTemplate: WhatsAppTemplate | null; userErrors: UserError[] };
}

export interface WhatsAppTemplateDeleteData {
  whatsAppTemplateDelete: { deletedWhatsAppTemplateId: string | null; userErrors: UserError[] };
}

export interface WhatsAppTemplatesSyncData {
  whatsAppTemplatesSync: { whatsAppTemplates: WhatsAppTemplate[]; userErrors: UserError[] };
}

export type BroadcastStatus = 'SCHEDULED' | 'SENDING' | 'SENT' | 'CANCELLED' | 'FAILED';

/** A WhatsApp broadcast (ADR-421): one approved template to a segment's subscribed customers. */
/** How a broadcast goes: from the shop's own WhatsApp number, or by SMS (ADR-458). */
export type BroadcastChannel = 'WHATSAPP' | 'SMS';

export interface Broadcast {
  id: string;
  name: string;
  channel: BroadcastChannel;
  /** A WhatsApp broadcast's template; none for SMS. */
  templateId: string | null;
  templateName: string | null;
  /** The template's language; for SMS, that of the words Hatti adds to the shop's. */
  templateLanguage: MessageLanguage;
  templateBody: string | null;
  /** An SMS campaign's own words; none for WhatsApp. */
  text: string | null;
  segmentId: string | null;
  segmentName: string | null;
  sendAt: string;
  status: BroadcastStatus;
  error: string | null;
  recipients: number;
  counts: {
    pending: number;
    sent: number;
    delivered: number;
    read: number;
    failed: number;
    skipped: number;
  };
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

export interface BroadcastsData {
  broadcasts: {
    nodes: Broadcast[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

export interface BroadcastEstimateData {
  broadcastEstimate: {
    recipients: number;
    /** The SMS each message goes in; one on WhatsApp. */
    partsPerMessage: number;
    pricePerMessage: MoneyValue;
    cost: MoneyValue;
  };
}

export interface BroadcastInput {
  name: string;
  /** WhatsApp unless said. */
  channel?: BroadcastChannel;
  /** For WhatsApp. */
  templateId?: string;
  /** For SMS: the shop's words, and the language of what Hatti adds to them. */
  text?: string;
  language?: MessageLanguage;
  segmentId: string | null;
  sendAt: string | null;
}

export interface BroadcastPayloadData {
  [mutation: string]: { broadcast: Broadcast | null; userErrors: UserError[] };
}

/** A gift card as the admin lists it (CAT-12, ADR-448). */
export interface GiftCard {
  id: string;
  lastCharacters: string;
  initialValue: { amount: string };
  balance: { amount: string };
  /** YYYY-MM-DD in the shop's time zone; null for never. */
  expiresOn: string | null;
  expired: boolean;
  enabled: boolean;
  note: string;
  createdAt: string;
}

export interface GiftCardsData {
  giftCards: { nodes: GiftCard[] };
}

export interface GiftCardCreateInput {
  initialValue: string;
  code?: string;
  expiresOn?: string;
  note?: string;
}

export interface GiftCardCreateData {
  giftCardCreate: {
    giftCard: GiftCard | null;
    giftCardCode: string | null;
    userErrors: UserError[];
  };
}

export interface GiftCardPayloadData {
  [mutation: string]: { giftCard: GiftCard | null; userErrors: UserError[] };
}

/** Whether a suit comes stitched (ADR-477). */
export type StitchingValue = 'UNSTITCHED' | 'SEMI_STITCHED' | 'STITCHED';

/** A fabric Pakistani shops sell eastern wear in (ADR-477). */
export type FabricValue =
  | 'LAWN'
  | 'CAMBRIC'
  | 'COTTON'
  | 'KHADDAR'
  | 'KARANDI'
  | 'LINEN'
  | 'MARINA'
  | 'VISCOSE'
  | 'DOBBY'
  | 'JACQUARD'
  | 'CHIFFON'
  | 'GEORGETTE'
  | 'ORGANZA'
  | 'NET'
  | 'SILK'
  | 'RAW_SILK'
  | 'VELVET'
  | 'JAMAWAR'
  | 'WOOL'
  | 'PASHMINA';

/** The season it is for (ADR-477). */
export type SeasonValue = 'SUMMER' | 'WINTER' | 'FESTIVE' | 'ALL_SEASON';

/** A product's eastern-wear attributes (CAT-08, ADR-477); each may be unsaid. */
export interface EasternWear {
  stitching: StitchingValue | null;
  pieces: number | null;
  fabrics: FabricValue[];
  season: SeasonValue | null;
}

// Hatti's own status (BIL-06, ADR-498).
export type PlatformIncidentStatusValue =
  | 'INVESTIGATING'
  | 'IDENTIFIED'
  | 'MONITORING'
  | 'RESOLVED'
  | 'SCHEDULED'
  | 'IN_PROGRESS'
  | 'COMPLETED';

export type PlatformComponentValue =
  'STOREFRONTS' | 'CHECKOUT' | 'ADMIN' | 'PAYMENTS' | 'COURIERS' | 'WHATSAPP' | 'SMS' | 'EMAIL';

export interface PlatformIncidentValue {
  id: string;
  kind: 'INCIDENT' | 'MAINTENANCE';
  impact: 'DEGRADED' | 'OUTAGE';
  status: PlatformIncidentStatusValue;
  components: PlatformComponentValue[];
  title: string;
  titleUr: string | null;
  startsAt: string;
  endsAt: string | null;
  latestUpdate: {
    status: PlatformIncidentStatusValue;
    body: string;
    bodyUr: string | null;
    postedAt: string;
  };
}

export interface PlatformStatusData {
  platformStatus: { statusPageUrl: string; incidents: PlatformIncidentValue[] };
}

/** What the store builder makes of a shop's description (ONB-03, ADR-502). */
export interface StoreBuildPlanValue {
  kit: 'FASHION' | 'JEWELLERY' | 'BEAUTY' | 'ELECTRONICS' | 'GROCERY' | null;
  accentColour: string;
  aboutHtml: string;
  seoTitle: string;
  seoDescription: string;
}

export interface StoreBuildPlanData {
  storeBuildPlan: StoreBuildPlanValue;
}

export interface StoreBuildData {
  storeBuild: {
    plan: StoreBuildPlanValue | null;
    collectionsMade: number;
    sizeChartsMade: number;
    menuLinksAdded: number;
    accentSet: boolean;
    seoSet: boolean;
    aboutPage: { id: string; handle: string } | null;
    userErrors: UserError[];
  };
}

/** Hatti's support for the shop (BIL-05, ADR-508). */
export type SupportChannel = 'HELP_CENTRE' | 'WHATSAPP' | 'PRIORITY_WHATSAPP' | 'PRIORITY_CALL';
export type SupportTopic =
  'ORDERS' | 'PAYMENTS' | 'COURIERS' | 'STORE' | 'BILLING' | 'ACCOUNT' | 'OTHER';
export type SupportRequestStatus = 'OPEN' | 'ANSWERED' | 'CLOSED';

export interface SupportRequestValue {
  id: string;
  topic: SupportTopic;
  message: string;
  callBack: string | null;
  status: SupportRequestStatus;
  answer: string | null;
  answeredBy: string | null;
  answeredAt: string | null;
  createdAt: string;
}

export interface HattiSupportData {
  hattiSupport: {
    plan: 'FREE' | 'STARTER' | 'GROWTH' | 'PRO';
    channel: SupportChannel;
    answerWithinHours: number;
    whatsapp: string | null;
    phone: string | null;
    email: string | null;
    hours: { en: string; ur: string } | null;
    requests: SupportRequestValue[];
  };
}

export interface SupportRequestPayload {
  request: SupportRequestValue | null;
  userErrors: UserError[];
}
