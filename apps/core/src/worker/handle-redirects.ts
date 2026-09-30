import {
  CatalogEvents,
  type CollectionService,
  type ProductService,
  type ProductUpdatedPayload,
} from '@hatti/catalog/public';
import type { Database } from '@hatti/db';
import type { DomainEvent } from '@hatti/events';
import { redirectMoved } from '@hatti/online-store/public';

/** Where the storefront shows products and collections, by the event that says one changed. */
const PREFIXES: Readonly<Record<string, 'products' | 'collections'>> = {
  [CatalogEvents.ProductUpdated]: 'products',
  [CatalogEvents.CollectionUpdated]: 'collections',
};

export interface HandleLookups {
  products: Pick<ProductService, 'handleOf'>;
  collections: Pick<CollectionService, 'handleOf'>;
}

export interface HandleRedirectsLogger {
  warn(obj: object, msg?: string): void;
}

/**
 * Sends shoppers from a product's or collection's old address to where it is now, when the change
 * of its handle asked for it, as Shopify's `redirectNewHandle` does (ADR-053). Where it is now is
 * read rather than taken from the event, so changes handled out of order still leave every old
 * address leading to the current one.
 */
export class HandleRedirects {
  /** The events {@link handle} reads. */
  static readonly EVENTS = Object.keys(PREFIXES);

  constructor(
    private readonly db: Database,
    private readonly lookups: HandleLookups,
    private readonly logger?: HandleRedirectsLogger,
  ) {}

  async handle(event: DomainEvent): Promise<void> {
    const prefix = PREFIXES[event.type];
    const { previousHandle, redirectNewHandle } = event.payload as Partial<ProductUpdatedPayload>;
    if (!prefix || !redirectNewHandle || !previousHandle) return;
    await this.db.tenant(event.shopId, async (tx) => {
      const handle = await this.lookups[prefix].handleOf(tx, event.shopId, event.aggregateId);
      // Deleted since: there is nowhere to send shoppers.
      if (handle === null) return;
      const from = `/${prefix}/${previousHandle}`;
      if (!(await redirectMoved(tx, event.shopId, from, `/${prefix}/${handle}`))) {
        this.logger?.warn(
          { shopId: event.shopId, from },
          'no redirect written: the shop keeps as many as it may',
        );
      }
    });
  }
}
