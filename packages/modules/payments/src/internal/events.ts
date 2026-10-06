/** Events the payments module publishes. Payloads are thin: fetch current state through the API. */
export const PaymentEvents = {
  /** The shop connected its account with a payment gateway (PAY-01). */
  GatewayAccountConnected: 'payment_gateway_account.connected',
  GatewayAccountUpdated: 'payment_gateway_account.updated',
  /** No new payments through the account; those made through it stay recorded. */
  GatewayAccountArchived: 'payment_gateway_account.archived',
  /** The shop put its live accounts in a new order, the one its customers are offered them in. */
  GatewayAccountsReordered: 'payment_gateway_accounts.reordered',
  /** The shop changed what paying online takes off (PAY-05, ADR-222). */
  OnlinePaymentSettingsUpdated: 'online_payment_settings.updated',
  /** A customer started paying an order online, on the gateway's page (PAY-04). */
  PaymentSessionStarted: 'payment_session.started',
  /** The gateway would not start a payment: see its error. */
  PaymentSessionFailed: 'payment_session.failed',
  /** The gateway said the payment is made; what of it the order owed is paid on it. */
  PaymentSessionPaid: 'payment_session.paid',
  /** The gateway gave money back of a payment, written on its order as a refund (PAY-06). */
  PaymentRefundRefunded: 'payment_refund.refunded',
  /** The gateway refused a refund, or did not answer: see its error, and whether `unknown`. */
  PaymentRefundFailed: 'payment_refund.failed',
} as const;

export interface GatewayAccountChangedPayload {
  gateway: string;
  environment: string;
  /** For updates: what changed, such as ["credentials", "environment"]. */
  changed?: string[];
  actorKind: 'staff' | 'app';
  actorId: string;
}

export interface GatewayAccountsReorderedPayload {
  /** The live accounts' gateways, in their new order: ["jazzcash", "safepay"]. */
  gateways: string[];
  actorKind: 'staff' | 'app';
  actorId: string;
}

export interface OnlinePaymentSettingsUpdatedPayload {
  /** "discount": what changed. */
  changed: string[];
  actorKind: 'staff' | 'app';
  actorId: string;
}

export interface PaymentSessionPayload {
  orderId: string;
  accountId: string;
  gateway: string;
  /** Minor units, as strings. */
  amount: string;
  /** Paid: what was paid, and what of it went towards what the order owed. */
  paidAmount?: string | null;
  applied?: string | null;
  /** Paid in the gateway's sandbox: no money moved, and the order is not paid. */
  test?: boolean;
  /** Failed: why. */
  error?: string | null;
}

export interface PaymentRefundPayload {
  orderId: string;
  sessionId: string;
  gateway: string;
  /** Minor units, as a string. */
  amount: string;
  /** Refunded: the gateway's reference, and the order's refund it was written as. */
  reference?: string | null;
  refundId?: string | null;
  /** Failed: why, and whether the gateway may have given it back all the same. */
  error?: string | null;
  unknown?: boolean;
}
