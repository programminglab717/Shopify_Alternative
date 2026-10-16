import { ProductService, bundlesOfVariantsIn, complementsIn } from '@hatti/catalog/public';
import type { Tx } from '@hatti/db';
import { InventoryService } from '@hatti/inventory/public';
import { exponentOf, type CurrencyCode } from '@hatti/money';
import { Injectable } from '@nestjs/common';
import { OrderEditService } from './order-edit.service.js';
import { orderSettingsIn } from './order-settings.service.js';
import { loadOrder } from './order-store.js';
import type { OrderRecord } from './records.js';
import type { OrderRow } from './schema.js';

/** A variant of the product offered, at the offer's price and its own. */
export interface OfferedVariant {
  variantId: string;
  /** "M", or "Default Title" for a product without options. */
  title: string;
  /** Minor units: what the customer pays for it. */
  price: bigint;
  /** Minor units: its price on the shop. */
  was: bigint;
}

/**
 * What a cash-on-delivery order's page offers its customer (MKT-09, ADR-438): one of the products
 * the shop pairs with what they bought, at the shop's percentage off, with its variants for sale.
 */
export interface PostPurchaseOffer {
  productId: string;
  title: string;
  percentOff: number;
  variants: OfferedVariant[];
}

/** The products weighed for an offer, at most: the first one for sale is offered. */
const CANDIDATES = 10;

/**
 * Whether an order's page may offer its customer something to add: a cash-on-delivery order
 * delivered to them, confirmed and waiting to be packed, that took no offer yet and was not
 * refunded or held over the shop's plan. Before it is confirmed, its customer is deciding on the
 * order itself.
 */
export function upsellOpen(
  order: Pick<
    OrderRecord,
    | 'stage'
    | 'paymentMethod'
    | 'deliveryMethod'
    | 'status'
    | 'fulfillmentStatus'
    | 'packedAt'
    | 'upsoldAt'
    | 'amountRefunded'
    | 'overLimitAt'
  >,
): boolean {
  return (
    order.stage === 'to_pack' &&
    order.paymentMethod === 'cash_on_delivery' &&
    order.deliveryMethod !== 'pickup' &&
    order.status === 'open' &&
    order.fulfillmentStatus === 'unfulfilled' &&
    !order.packedAt &&
    !order.upsoldAt &&
    order.amountRefunded === 0n &&
    !order.overLimitAt
  );
}

/** `price` less `percent` off, down to a whole unit of `currency`, as cash is counted. */
export function offerPrice(price: bigint, percent: number, currency: CurrencyCode): bigint {
  const unit = 10n ** BigInt(exponentOf(currency));
  const cut = (price * BigInt(100 - percent)) / 100n;
  return cut - (cut % unit);
}

/**
 * The post-purchase offer (MKT-09, 05 §8, ADR-438): one product the shop pairs with what a
 * cash-on-delivery order holds, added from its page with a tap and paid at the door, until it is
 * packed. No payment is taken again: the rider collects it with the rest.
 */
@Injectable()
export class PostPurchaseOffers {
  constructor(
    private readonly products: ProductService,
    private readonly inventory: InventoryService,
    private readonly edits: OrderEditService,
  ) {}

  /**
   * What the order's page offers now, in the caller's transaction `tx`: the first product the shop
   * pairs with its items, in their order, that it does not hold, is for sale and has a variant in
   * stock; null where the shop makes no offer or the order takes none.
   */
  async offerIn(tx: Tx, shopId: string, order: OrderRecord): Promise<PostPurchaseOffer | null> {
    if (!upsellOpen(order)) return null;
    const { upsellPercentOff: percentOff } = await orderSettingsIn(tx, shopId);
    if (percentOff === null) return null;
    const held = new Set(order.lines.map((line) => line.productId));
    const paired = await complementsIn(tx, shopId, [...held]);
    const candidates = [...new Set(order.lines.flatMap((line) => paired.get(line.productId) ?? []))]
      .filter((id) => !held.has(id))
      .slice(0, CANDIDATES);
    if (candidates.length === 0) return null;
    const records = new Map(
      (await this.products.recordsOf(tx, shopId, candidates)).map((record) => [record.id, record]),
    );
    const variantIds = [...records.values()].flatMap((record) =>
      record.variants.map((variant) => variant.id),
    );
    const available = await this.inventory.availableOf(tx, shopId, variantIds);
    // A bundle is sold as its parts, which an order adds itself (ADR-410).
    const bundles = await bundlesOfVariantsIn(tx, shopId, variantIds);
    const currency = order.currency as CurrencyCode;
    for (const id of candidates) {
      const record = records.get(id);
      if (!record || record.status !== 'active') continue;
      const variants = record.variants
        .filter((variant) => available.get(variant.id) && !bundles.has(variant.id))
        .map((variant) => ({
          variantId: variant.id,
          title: variant.title,
          price: offerPrice(variant.price, percentOff, currency),
          was: variant.price,
        }));
      if (variants.length > 0) {
        return { productId: record.id, title: record.title, percentOff, variants };
      }
    }
    return null;
  }

  /**
   * Adds one of `variantId` of the offer to an order locked in `tx`, at the offer's price, as its
   * customer asked on its page. Why not, if not: the offer is gone or no longer has the variant,
   * or the order cannot take it, as when it would collect more cash than the law allows.
   */
  async takeLocked(
    tx: Tx,
    shopId: string,
    order: OrderRow,
    variantId: string,
  ): Promise<'gone' | 'refused' | null> {
    const record = (await loadOrder(tx, shopId, order.id))!;
    const offer = await this.offerIn(tx, shopId, record);
    const variant = offer?.variants.find((each) => each.variantId === variantId);
    if (!variant) return 'gone';
    const done = await this.edits.addOfferedLocked(tx, shopId, order, variantId, variant.price);
    return done.ok ? null : 'refused';
  }
}
