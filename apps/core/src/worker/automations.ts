import type { TenantContext } from '@hatti/api';
import {
  CustomerEvents,
  type CustomerService,
  type MarketingConsentUpdatedPayload,
} from '@hatti/customers/public';
import type { DomainEvent } from '@hatti/events';
import type { Logger } from '@hatti/logger';
import type { AutomationsService } from '@hatti/messaging/public';
import { repeat } from './repeat.js';

/**
 * Where a customer's subscribing is theirs, and so welcomed: at checkout or on the storefront.
 * Not staff ticking it, an app, or an import, which would welcome a whole list at once.
 */
const WELCOMED_FROM: readonly string[] = ['checkout', 'storefront'];

/** The shop as the worker acts for it: only its ID is read. */
function workerTenant(shopId: string): TenantContext {
  return {
    shopId,
    currency: 'PKR',
    actor: { kind: 'app', tokenId: '00000000-0000-0000-0000-000000000000' },
    scopes: new Set(),
  };
}

/**
 * Starts the shop's automations as its customers' events are heard (MKT-04, ADR-425): a welcome to
 * a customer who agreed to hear from the shop on WhatsApp at checkout or on its storefront, if
 * they still do when the event is heard.
 */
export class AutomationTriggers {
  /** The events {@link handle} reads. */
  static readonly EVENTS: readonly string[] = [CustomerEvents.MarketingConsentUpdated];

  constructor(
    private readonly automations: Pick<AutomationsService, 'welcome'>,
    private readonly customers: Pick<CustomerService, 'get'>,
  ) {}

  async handle(event: DomainEvent): Promise<void> {
    const { channel, state, source } = event.payload as Partial<MarketingConsentUpdatedPayload>;
    if (channel !== 'whatsapp' || state !== 'subscribed' || !WELCOMED_FROM.includes(source ?? '')) {
      return;
    }
    const customer = await this.customers.get(workerTenant(event.shopId), event.aggregateId);
    if (customer?.consent.whatsapp.state !== 'subscribed') return;
    await this.automations.welcome(event.shopId, {
      id: customer.id,
      phone: customer.phone,
      name: customer.name,
    });
  }
}

/**
 * Wins back lapsed customers (MKT-04, ADR-425): each sweep, every shop whose win-back is on, one
 * shop's failure not the others'.
 */
export class WinBacks {
  constructor(
    private readonly automations: Pick<AutomationsService, 'winBackShops' | 'winBack'>,
    private readonly logger?: Logger,
  ) {}

  /** One sweep: how many messages it queued. */
  async sweep(at: Date = new Date()): Promise<number> {
    let queued = 0;
    for (const shopId of await this.automations.winBackShops()) {
      try {
        const count = await this.automations.winBack(shopId, at);
        if (count > 0) this.logger?.info({ shopId, queued: count }, 'customers won back');
        queued += count;
      } catch (error) {
        this.logger?.warn({ err: error, shopId }, 'win-back not sent');
      }
    }
    return queued;
  }

  /** Sweeps now, then every `intervalMs`, a sweep never overlapping the last. */
  start(intervalMs: number): { stop(): Promise<void> } {
    return repeat(
      () => this.sweep(),
      intervalMs,
      (error) => this.logger?.warn({ err: error }, 'win-back sweep failed'),
    );
  }
}
