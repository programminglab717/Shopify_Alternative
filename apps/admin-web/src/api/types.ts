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
