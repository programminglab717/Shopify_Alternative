import type { Logger } from '@hatti/logger';
import {
  FbrDigitalInvoicingClient,
  FbrPosClient,
  FbrPosService,
  FiscalInvoicesService,
  fbrInvoiceRequest,
  type ClaimedFiscalInvoice,
  type FbrConnection,
  type FbrReportResult,
  type FiscalOutcome,
} from '@hatti/tax/public';
import { repeat } from './repeat.js';

/** Invoices a shop reports in a round: FBR takes one a request. */
const BATCH = 50;

/** How long a round may hold those it took before another may take them. */
const LEASE_MS = 5 * 60_000;

/** How long FBR is tried for an invoice before it is given up as failed: a week. */
export const FISCAL_GIVE_UP_MS = 7 * 24 * 60 * 60_000;

/** The wait after the `attempts`th try failed: a minute, doubling, at most six hours. */
export function fiscalRetryDelayMs(attempts: number): number {
  return Math.min(60_000 * 2 ** Math.max(attempts - 1, 0), 6 * 60 * 60_000);
}

/** What the shop's connection is called, saying it is not what an invoice was kept for. */
const SYSTEM_NAMES = {
  pos: "FBR's POS integration",
  digital_invoicing: "FBR's digital invoicing",
} as const;

export interface FiscalReporterOptions {
  fiscal: FiscalInvoicesService;
  pos: FbrPosService;
  /** FBR's IMS, for shops reporting from their POS. */
  client: FbrPosClient;
  /** FBR's digital invoicing, for shops registered for sales tax (ADR-562). */
  digitalInvoicing: FbrDigitalInvoicingClient;
  logger?: Logger;
}

/**
 * Reports shops' invoices and credit notes to FBR as they are issued, the oldest first: Tier-1
 * shops' to FBR's IMS from the POS each connected (POS-04, ADR-555), and invoices of shops
 * registered for sales tax through FBR's digital invoicing (TAX-04, ADR-562), each through what
 * it was kept for. Each one FBR takes is settled with the number FBR gave it, one FBR refuses
 * fails saying why, and one FBR cannot be reached for is tried again later, for a week.
 */
export class FiscalReporter {
  constructor(private readonly options: FiscalReporterOptions) {}

  /** One round: every shop with invoices due reports them. How many FBR took. */
  async sweep(at: Date = new Date()): Promise<number> {
    const shops = await this.options.fiscal.dueShops(at);
    let reported = 0;
    for (const shopId of shops) {
      try {
        reported += await this.report(shopId, at);
      } catch (error) {
        // One shop's failure is not the others': its invoices are due again after their lease.
        this.options.logger?.warn({ err: error, shopId }, 'fiscal invoices not reported');
      }
    }
    return reported;
  }

  /** Reports the shop's invoices due at `at`. How many FBR took. */
  async report(shopId: string, at: Date): Promise<number> {
    const { fiscal, pos } = this.options;
    const claimed = await fiscal.claim(shopId, at, BATCH, LEASE_MS);
    if (claimed.length === 0) return 0;
    const connection = await pos.connectionOf(shopId);
    const outcomes: FiscalOutcome[] = [];
    for (const invoice of claimed) {
      if (!connection) {
        outcomes.push({
          id: invoice.id,
          status: 'skipped',
          error: 'Not reported: the shop disconnected FBR',
        });
        continue;
      }
      // Kept in the shape of the other, it goes to neither.
      if (connection.system !== invoice.system) {
        outcomes.push({
          id: invoice.id,
          status: 'skipped',
          error: `Not reported: the shop now reports through ${SYSTEM_NAMES[connection.system]}`,
        });
        continue;
      }
      const result = await this.send(connection, invoice);
      if (result.ok) {
        outcomes.push({ id: invoice.id, status: 'reported', invoiceNumber: result.invoiceNumber });
      } else if (result.retry && at.getTime() - invoice.createdAt.getTime() < FISCAL_GIVE_UP_MS) {
        outcomes.push({
          id: invoice.id,
          status: 'pending',
          nextAttemptAt: new Date(at.getTime() + fiscalRetryDelayMs(invoice.attempts)),
          error: result.message,
        });
      } else {
        outcomes.push({ id: invoice.id, status: 'failed', error: result.message });
      }
    }
    await fiscal.settle(shopId, outcomes, at);
    return outcomes.filter((outcome) => outcome.status === 'reported').length;
  }

  /** Sends `invoice` through `connection`, which is what it was kept for. */
  private send(connection: FbrConnection, invoice: ClaimedFiscalInvoice): Promise<FbrReportResult> {
    if (connection.system === 'pos' && invoice.system === 'pos') {
      return this.options.client.report(
        connection,
        fbrInvoiceRequest(invoice.body, connection.posId, connection.pctCode),
      );
    }
    if (connection.system === 'digital_invoicing' && invoice.system === 'digital_invoicing') {
      return this.options.digitalInvoicing.report(connection, invoice.body);
    }
    throw new Error(
      `Invoice ${invoice.id} was kept for ${invoice.system}, not ${connection.system}`,
    );
  }

  /** Reports now, then every `intervalMs`, a round never overlapping the last. */
  start(intervalMs: number): { stop(): Promise<void> } {
    return repeat(
      () => this.sweep(),
      intervalMs,
      (error) => this.options.logger?.warn({ err: error }, 'fiscal invoices sweep failed'),
    );
  }
}
