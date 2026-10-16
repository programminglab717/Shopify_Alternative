import { shopProfile, type StorefrontSite, type TenantContext } from '@hatti/api';
import {
  DEFAULT_VARIANT_TITLE,
  type ProductService,
  type VariantService,
} from '@hatti/catalog/public';
import type { Database } from '@hatti/db';
import type { DomainEvent } from '@hatti/events';
import {
  InventoryEvents,
  type InventoryLevelUpdatedPayload,
  type InventoryService,
} from '@hatti/inventory/public';
import { automationOnIn, type StockWatchService } from '@hatti/messaging/public';

/** The shop as the worker reads its products: only its ID is read. */
function workerTenant(shopId: string): TenantContext {
  return {
    shopId,
    currency: 'PKR',
    actor: { kind: 'app', tokenId: '00000000-0000-0000-0000-000000000000' },
    scopes: new Set(),
  };
}

/**
 * Back in stock (MKT-04, ADR-429): as a variant's stock changes, or whether it is tracked or kept
 * selling at zero, the shoppers who asked to hear of it are told once it can be sold online again,
 * each once, on WhatsApp with its page's link, while the shop's automation is on and the product
 * is on sale. Nothing is asked of a variant nobody waits for.
 */
export class BackInStockAlerts {
  /** The events {@link handle} reads: each names the variant. */
  static readonly EVENTS: readonly string[] = [
    InventoryEvents.InventoryLevelUpdated,
    InventoryEvents.InventoryItemUpdated,
  ];

  constructor(
    private readonly database: Database,
    private readonly watches: StockWatchService,
    private readonly inventory: InventoryService,
    private readonly variants: VariantService,
    private readonly products: ProductService,
    private readonly storefronts: StorefrontSite,
  ) {}

  /** How many shoppers it told. */
  async handle(event: DomainEvent): Promise<number> {
    const variantId =
      event.type === InventoryEvents.InventoryLevelUpdated
        ? (event.payload as Partial<InventoryLevelUpdatedPayload>).inventoryItemId
        : event.aggregateId;
    if (!variantId) return 0;
    const { shopId } = event;
    return this.database.tenant(shopId, async (tx) => {
      const waiting = await this.watches.waitingIn(tx, shopId, variantId);
      if (waiting.length === 0) return 0;
      if (!(await automationOnIn(tx, shopId, 'back_in_stock'))) return 0;
      if (!(await this.inventory.availableOf(tx, shopId, [variantId])).get(variantId)) return 0;
      const variant = (await this.variants.snapshotsOf(tx, shopId, [variantId])).get(variantId);
      if (variant?.productStatus !== 'active') return 0;
      const product = await this.products.get(workerTenant(shopId), variant.productId);
      if (!product) return 0;
      const store = this.storefronts.url((await shopProfile(tx, shopId)).handle);
      return this.watches.notifyIn(tx, shopId, waiting, {
        product:
          variant.variantTitle === DEFAULT_VARIANT_TITLE
            ? variant.productTitle
            : `${variant.productTitle} (${variant.variantTitle})`,
        url: `${store}/products/${product.handle}?variant=${variantId}`,
      });
    });
  }
}
