/** Events the billing module publishes. Payloads are thin: fetch current state through the API. */
export const BillingEvents = {
  /** The shop's plan changed: paid for, chosen to begin when its period ends, or ended. */
  SubscriptionChanged: 'billing_subscription.changed',
  /** An invoice waits to be paid: a plan chosen now, or the plan's next period. */
  InvoiceCreated: 'billing_invoice.created',
  /** Hatti's gateway said the invoice is paid; its plan runs for the period paid for. */
  InvoicePaid: 'billing_invoice.paid',
} as const;

export interface SubscriptionChangedPayload {
  plan: string;
  interval: string | null;
  periodEnd: string | null;
  /** A smaller plan, or Free, chosen to begin when the period ends. */
  nextPlan: string | null;
  /** paid: an invoice paid; scheduled: a plan chosen for later, or none; ended: back on Free. */
  reason: 'paid' | 'scheduled' | 'ended' | 'lapsed';
}

export interface InvoicePayload {
  number: string;
  reason: string;
  plan: string;
  interval: string;
  /** Paisa, as strings. */
  amount: string;
}
