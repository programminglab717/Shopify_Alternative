/** Events the payments module publishes. Payloads are thin: fetch current state through the API. */
export const PaymentEvents = {
  /** The shop connected its account with a payment gateway (PAY-01). */
  GatewayAccountConnected: 'payment_gateway_account.connected',
  GatewayAccountUpdated: 'payment_gateway_account.updated',
  /** No new payments through the account; those made through it stay recorded. */
  GatewayAccountArchived: 'payment_gateway_account.archived',
  /** A customer started paying an order online, on the gateway's page (PAY-04). */
  PaymentSessionStarted: 'payment_session.started',
  /** The gateway would not start a payment: see its error. */
  PaymentSessionFailed: 'payment_session.failed',
  /** The gateway said the payment is made; what of it the order owed is paid on it. */
  PaymentSessionPaid: 'payment_session.paid',
} as const;

export interface GatewayAccountChangedPayload {
  gateway: string;
  environment: string;
  /** For updates: what changed, such as ["credentials", "environment"]. */
  changed?: string[];
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
