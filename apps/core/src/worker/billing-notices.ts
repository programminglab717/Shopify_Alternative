import { shopProfile } from '@hatti/api';
import {
  BILLING_CURRENCY,
  BillingEvents,
  PLANS,
  type CreditLowPayload,
  type InvoicePayload,
  type InvoiceTransferPayload,
  type Plan,
  type PlanCode,
  type SubscriptionChangedPayload,
} from '@hatti/billing/public';
import type { Database } from '@hatti/db';
import type { DomainEvent } from '@hatti/events';
import type { MessageKind, MessagesService, MessageVariables } from '@hatti/messaging/public';
import { formatMoney, money } from '@hatti/money';
import { tellShop } from './shop-notices.js';

/**
 * Tells a shop of its bills with Hatti (BIL-01, BIL-03, ADR-169), as billing's events are heard:
 * its plan's next period invoiced, its plan ended unpaid, its message credit fallen below Rs 100,
 * and what Hatti's people found of a transfer it said it made (ADR-254): one that paid its
 * invoice, or one not found, and why. On WhatsApp at the shop's alerts number, in the shop's language, where it gives one; and
 * by email to its owner, at the address their account proved, in their own language (ADR-195),
 * which identity gives for the shop alone. Each once, and at Hatti's cost: never the shop's credit.
 */
export class BillingNotices {
  /** The events {@link handle} reads. */
  static readonly EVENTS: readonly string[] = [
    BillingEvents.InvoiceCreated,
    BillingEvents.SubscriptionChanged,
    BillingEvents.CreditLow,
    BillingEvents.InvoiceTransferConfirmed,
    BillingEvents.InvoiceTransferRefused,
  ];

  constructor(
    private readonly database: Database,
    private readonly messages: MessagesService,
  ) {}

  async handle(event: DomainEvent): Promise<void> {
    const notice = noticeOf(event);
    if (!notice) return;
    const { shopId } = event;
    await this.database.tenant(shopId, async (tx) => {
      const variables = { shop: (await shopProfile(tx, shopId)).name, ...notice.variables };
      await tellShop(tx, this.messages, shopId, { ...notice, variables });
    });
  }
}

interface Notice {
  kind: MessageKind;
  dedupeKey: string;
  /** All but the shop's name, which the shop's own transaction reads. */
  variables: Omit<MessageVariables, 'shop'>;
}

/**
 * What `event` tells the shop, if anything: a plan's renewal, its end unpaid, credit low, or what
 * Hatti found of a transfer.
 */
function noticeOf(event: DomainEvent): Notice | null {
  switch (event.type) {
    case BillingEvents.InvoiceCreated: {
      const invoice = event.payload as Partial<InvoicePayload>;
      // A plan chosen, or credit, is invoiced as the shop asks for it, in the admin.
      if (invoice.reason !== 'renewal' || !invoice.number || !invoice.amount) return null;
      const plan: Plan | undefined = PLANS[invoice.plan as PlanCode];
      if (!plan) return null;
      return {
        kind: 'invoice_due',
        dedupeKey: `invoice_due:${event.aggregateId}`,
        variables: { invoice: invoice.number, plan: plan.name, amount: rupees(invoice.amount) },
      };
    }
    case BillingEvents.SubscriptionChanged: {
      const { reason } = event.payload as Partial<SubscriptionChangedPayload>;
      // Free chosen next, by the shop, needs no telling.
      if (reason !== 'lapsed') return null;
      return { kind: 'plan_ended', dedupeKey: `plan_ended:${event.id}`, variables: {} };
    }
    case BillingEvents.CreditLow: {
      const { balance } = event.payload as Partial<CreditLowPayload>;
      if (balance === undefined) return null;
      return {
        kind: 'credit_low',
        dedupeKey: `credit_low:${event.id}`,
        variables: { balance: rupees(balance) },
      };
    }
    case BillingEvents.InvoiceTransferConfirmed: {
      const transfer = event.payload as Partial<InvoiceTransferPayload>;
      // One short of its invoice, or for one paid otherwise, Hatti's people take up themselves.
      if (!transfer.paid || !transfer.number || !transfer.received || !transfer.reference) {
        return null;
      }
      return {
        kind: 'transfer_confirmed',
        dedupeKey: `transfer_confirmed:${event.id}`,
        variables: {
          invoice: transfer.number,
          amount: rupees(transfer.received),
          reference: transfer.reference,
        },
      };
    }
    case BillingEvents.InvoiceTransferRefused: {
      const transfer = event.payload as Partial<InvoiceTransferPayload>;
      if (!transfer.number || !transfer.reference || !transfer.reason) return null;
      return {
        kind: 'transfer_refused',
        dedupeKey: `transfer_refused:${event.id}`,
        variables: {
          invoice: transfer.number,
          reference: transfer.reference,
          reason: transfer.reason,
        },
      };
    }
    default:
      return null;
  }
}

/** Paisa, as a payload says them, in rupees: "Rs 2,499". */
function rupees(paisa: string): string {
  return formatMoney(money(BigInt(paisa), BILLING_CURRENCY));
}
