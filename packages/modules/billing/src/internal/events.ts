/** Events the billing module publishes. Payloads are thin: fetch current state through the API. */
export const BillingEvents = {
  /** The shop's plan changed: paid for, chosen to begin when its period ends, or ended. */
  SubscriptionChanged: 'billing_subscription.changed',
  /** An invoice waits to be paid: a plan chosen now, the plan's next period, or credit. */
  InvoiceCreated: 'billing_invoice.created',
  /**
   * Hatti's gateway said the invoice is paid: its plan runs for the period paid for, or its credit
   * is the shop's.
   */
  InvoicePaid: 'billing_invoice.paid',
  /**
   * The plan's period ended and its renewal is unpaid (BIL-04, ADR-511): sent the day it ends,
   * with three days left and with one, before the shop is on Free.
   */
  PaymentOverdue: 'billing_invoice.overdue',
  /** The shop's message credit fell below what a few days of messages cost (ADR-169). */
  CreditLow: 'billing_credit.low',
  /** The shop's owner said they paid an invoice by transfer into Hatti's account (ADR-254). */
  InvoiceTransferReported: 'billing_invoice.transfer_reported',
  /** Hatti's people found it in Hatti's account: it paid the invoice, or went towards it. */
  InvoiceTransferConfirmed: 'billing_invoice.transfer_confirmed',
  /** Hatti's people found no such transfer, or not as the shop said it: see the reason. */
  InvoiceTransferRefused: 'billing_invoice.transfer_refused',
} as const;

export interface InvoiceTransferPayload {
  number: string;
  /** Paisa, as a string: what the invoice asked for when the transfer was said. */
  amount: string;
  /** As the shop's owner gave it. */
  reference: string;
  /** Confirmed: paisa, as a string, what Hatti's people found; and whether it paid the invoice. */
  received?: string;
  paid?: boolean;
  /** Refused: why. */
  reason?: string;
}

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
  /** None for credit. */
  plan: string | null;
  interval: string | null;
  /** Paisa, as strings. */
  amount: string;
}

export interface PaymentOverduePayload {
  /** The renewal's invoice waiting to be paid. */
  number: string;
  plan: string;
  /** Paisa, as a string. */
  amount: string;
  /** Whole days left before the shop is on Free: 7, 3 or 1, or fewer where a reminder was late. */
  daysLeft: number;
  /** When the shop is on Free unless the invoice is paid, ISO 8601. */
  freeAt: string;
}

export interface CreditLowPayload {
  /** Paisa, as a string: what the credit holds now. */
  balance: string;
}
