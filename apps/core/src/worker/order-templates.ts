import type { Logger } from '@hatti/logger';
import type { WhatsAppBusinessClient, WhatsAppTemplatesService } from '@hatti/messaging/public';
import { repeat } from './repeat.js';

/**
 * Sends Hatti's order templates to each shop's own WhatsApp Business Account (ADR-537): a few
 * shops a round, each account at most once a day until it has all of them, their links to
 * `orderPage` followed by an order's own part. What Meta refuses is logged, and tried again the
 * next day; Meta's word on each template comes by its webhook.
 */
export class OrderTemplates {
  constructor(
    private readonly templates: Pick<WhatsAppTemplatesService, 'libraryDue' | 'sendLibrary'>,
    private readonly graph: Pick<WhatsAppBusinessClient, 'templatesOf' | 'submitTemplate'>,
    private readonly orderPage: string,
    private readonly logger?: Pick<Logger, 'info' | 'warn'>,
  ) {}

  /** One round. How many templates went to Meta, or were found there already. */
  async sweep(at: Date = new Date()): Promise<number> {
    let count = 0;
    for (const shopId of await this.templates.libraryDue(at)) {
      try {
        const sent = await this.templates.sendLibrary(shopId, this.orderPage, this.graph, at);
        count += sent.submitted + sent.adopted;
        if (sent.submitted + sent.adopted > 0) {
          this.logger?.info(
            { shopId, submitted: sent.submitted, adopted: sent.adopted },
            "order templates sent to the shop's WhatsApp account",
          );
        }
        if (sent.errors.length > 0) {
          this.logger?.warn({ shopId, errors: sent.errors }, 'order templates refused by Meta');
        }
      } catch (error) {
        // One shop's failure is not the others': its account is tried again tomorrow.
        this.logger?.warn({ err: error, shopId }, 'order templates not sent');
      }
    }
    return count;
  }

  /** Sends now, then every `intervalMs`, a round never overlapping the last. */
  start(intervalMs: number): { stop(): Promise<void> } {
    return repeat(
      () => this.sweep(),
      intervalMs,
      (error) => this.logger?.warn({ err: error }, 'order templates sweep failed'),
    );
  }
}
