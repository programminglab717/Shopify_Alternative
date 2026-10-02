import { shopProfile } from '@hatti/api';
import {
  BILLING_CURRENCY,
  BillingEvents,
  PLANS,
  type CreditLowPayload,
  type InvoicePayload,
  type Plan,
  type PlanCode,
  type SubscriptionChangedPayload,
} from '@hatti/billing/public';
import type { Database } from '@hatti/db';
import type { DomainEvent } from '@hatti/events';
import {
  settingsIn,
  type MessageKind,
  type MessagesService,
  type MessageVariables,
} from '@hatti/messaging/public';
import { formatMoney, money } from '@hatti/money';

/**
 * Tells a shop on WhatsApp of its bills with Hatti (BIL-01, BIL-03, ADR-169), as billing's events
 * are heard: its plan's next period invoiced, its plan ended unpaid, and its message credit fallen
 * below Rs 100. At the shop's alerts number, once each, and at Hatti's cost: never the shop's
 * credit. Nothing while the shop gives no number.
 */
export class BillingNotices {
  /** The events {@link handle} reads. */
  static readonly EVENTS: readonly string[] = [
    BillingEvents.InvoiceCreated,
    BillingEvents.SubscriptionChanged,
    BillingEvents.CreditLow,
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
      const { alertsPhone } = await settingsIn(tx, shopId);
      if (!alertsPhone) return;
      await this.messages.queueIn(tx, shopId, {
        kind: notice.kind,
        recipient: alertsPhone,
        dedupeKey: notice.dedupeKey,
        variables: { shop: (await shopProfile(tx, shopId)).name, ...notice.variables },
        channel: 'whatsapp',
      });
    });
  }
}

interface Notice {
  kind: MessageKind;
  dedupeKey: string;
  /** All but the shop's name, which the shop's own transaction reads. */
  variables: Omit<MessageVariables, 'shop'>;
}

/** What `event` tells the shop, if anything: a plan's renewal, its end unpaid, or credit low. */
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
    default:
      return null;
  }
}

/** Paisa, as a payload says them, in rupees: "Rs 2,499". */
function rupees(paisa: string): string {
  return formatMoney(money(BigInt(paisa), BILLING_CURRENCY));
}
