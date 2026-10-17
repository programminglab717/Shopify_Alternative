import { BillingEvents, type InvoicePayload } from '@hatti/billing/public';
import type { Database } from '@hatti/db';
import type { DomainEvent } from '@hatti/events';
import { recordPartnerEarning } from '@hatti/identity/public';

/**
 * Earns a partner their share of each plan invoice a store they brought pays Hatti (PRT-02,
 * ADR-505), as billing says it is paid: through identity's function, in the shop's own
 * transaction, once an invoice; nothing of message credit, nor of a shop no partner brought.
 */
export class PartnerEarnings {
  /** The events {@link handle} reads. */
  static readonly EVENTS: readonly string[] = [BillingEvents.InvoicePaid];

  constructor(private readonly database: Database) {}

  async handle(event: DomainEvent): Promise<void> {
    const invoice = event.payload as unknown as InvoicePayload;
    if (event.type !== BillingEvents.InvoicePaid || invoice.plan === null) return;
    const number = invoice.number.replace(/\D/g, '');
    if (!number) return;
    await this.database.tenant(event.shopId, (tx) =>
      recordPartnerEarning(tx, event.shopId, {
        id: event.aggregateId,
        number,
        plan: invoice.plan!,
        amount: BigInt(invoice.amount),
      }),
    );
  }
}
