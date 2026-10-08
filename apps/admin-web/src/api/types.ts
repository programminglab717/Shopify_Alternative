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
