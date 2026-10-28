import { BillingEvents, type InvoicePayload } from '@hatti/billing/public';
import type { Database } from '@hatti/db';
import type { DomainEvent } from '@hatti/events';
import { recordPartnerEarning, recordThemeSale } from '@hatti/identity/public';

/**
 * Earns a partner their share of each plan invoice a store they brought pays Hatti (PRT-02,
 * ADR-505), and a designer theirs of each theme of theirs a shop buys (ADR-853), as billing says
 * it is paid: through identity's functions, in the shop's own transaction, once an invoice;
 * nothing of message credit, nor of a shop no partner brought.
 */
export class PartnerEarnings {
  /** The events {@link handle} reads. */
  static readonly EVENTS: readonly string[] = [BillingEvents.InvoicePaid];

  constructor(private readonly database: Database) {}

  async handle(event: DomainEvent): Promise<void> {
    const invoice = event.payload as unknown as InvoicePayload;
    if (event.type !== BillingEvents.InvoicePaid) return;
    const number = invoice.number.replace(/\D/g, '');
    if (!number) return;
    // A theme of the theme store earns its designer their share (ADR-853).
    if (invoice.reason === 'theme' && invoice.themeId) {
      await this.database.tenant(event.shopId, (tx) =>
        recordThemeSale(tx, event.shopId, {
          id: event.aggregateId,
          number,
          themeId: invoice.themeId!,
          amount: BigInt(invoice.amount) - BigInt(invoice.tax ?? '0'),
        }),
      );
      return;
    }
    if (invoice.plan === null) return;
    await this.database.tenant(event.shopId, (tx) =>
      recordPartnerEarning(tx, event.shopId, {
        id: event.aggregateId,
        number,
        plan: invoice.plan!,
        // What Hatti earns: the invoice less the sales tax it collects for the province.
        amount: BigInt(invoice.amount) - BigInt(invoice.tax ?? '0'),
      }),
    );
  }
}
