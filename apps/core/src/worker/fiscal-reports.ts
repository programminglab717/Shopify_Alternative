import type { Logger } from '@hatti/logger';
import {
  FbrPosClient,
  FbrPosService,
  FiscalInvoicesService,
  fbrInvoiceRequest,
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

export interface FiscalReporterOptions {
  fiscal: FiscalInvoicesService;
  pos: FbrPosService;
  client: FbrPosClient;
  logger?: Logger;
}

/**
 * Reports Tier-1 shops' invoices and credit notes to FBR's IMS as they are issued (POS-04,
 * ADR-555), from the POS each shop connected, the oldest first: each one FBR takes is settled with
 * the number FBR gave it, one FBR refuses fails saying why, and one FBR cannot be reached for is
 * tried again later, for a week.
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
    const { fiscal, pos, client } = this.options;
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
      const result = await client.report(
        connection,
        fbrInvoiceRequest(invoice.body, connection.posId, connection.pctCode),
      );
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

  /** Reports now, then every `intervalMs`, a round never overlapping the last. */
  start(intervalMs: number): { stop(): Promise<void> } {
    return repeat(
      () => this.sweep(),
      intervalMs,
      (error) => this.options.logger?.warn({ err: error }, 'fiscal invoices sweep failed'),
    );
  }
}
