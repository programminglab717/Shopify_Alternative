import { CurrentTenant, RequireScopes, UserError, type TenantContext } from '@hatti/api';
import { PastOrderService, type PastOrderInput } from '@hatti/orders/public';
import { readStoreOrders, type StoreOrder } from '@hatti/shopify-admin';
import { Args, Field, Int, Mutation, ObjectType, Resolver } from '@nestjs/graphql';
import { ShopifyStores, storeGiven, storeRefusalOf } from './shopify-stores.js';

@ObjectType()
export class OrdersImportFromShopifyPayload {
  @Field(() => Int, { description: 'Orders the store has.' })
  orders!: number;

  @Field(() => Int, { description: 'Past orders kept, or that would be in a dry run.' })
  created!: number;

  @Field(() => Int, { description: 'Orders kept already, left as they are.' })
  skipped!: number;

  @Field(() => Int, {
    description: "Of those kept, how many name one of the shop's customers by their number.",
  })
  linked!: number;

  @Field()
  dryRun!: boolean;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

/**
 * A Shopify store's orders through its Admin API (ONB-05, ADR-786), kept as the shop's past
 * orders: a history to look back on, never orders of Hatti's.
 */
@Resolver()
export class OrdersFromShopifyResolver {
  constructor(
    private readonly past: PastOrderService,
    private readonly shopify: ShopifyStores,
  ) {}

  @Mutation(() => OrdersImportFromShopifyPayload, {
    description:
      "Imports a Shopify store's orders through its Admin API (ONB-05, ADR-786) as the shop's " +
      'past orders, which pastOrders gives: each with its name, items, amounts, how it was paid ' +
      'and sent, where it went, and the customer its number is, so their page shows what they ' +
      'bought before. Past orders take no stock, send no messages, book no parcels and count in ' +
      'no report. Orders brought already are left as they are; bring customers first, so the ' +
      'orders find them. Give the store and its app as productsImportFromShopify takes them; ' +
      'the app needs the read_orders access scope, read_all_orders for those over 60 days old, ' +
      "and Shopify's leave to read customers' details. Nothing given is kept. dryRun reads the " +
      'store and counts, changing nothing.',
  })
  @RequireScopes('write_orders')
  async ordersImportFromShopify(
    @CurrentTenant() tenant: TenantContext,
    @Args('store', {
      description:
        "The store's address at Shopify, as zari.myshopify.com, its name, or a link to its admin.",
    })
    store: string,
    @Args('accessToken', { nullable: true }) accessToken?: string,
    @Args('clientId', { nullable: true }) clientId?: string,
    @Args('clientSecret', { nullable: true }) clientSecret?: string,
    @Args('dryRun', { nullable: true }) dryRun?: boolean,
  ): Promise<OrdersImportFromShopifyPayload> {
    const dry = dryRun ?? false;
    const payload = (values: Partial<OrdersImportFromShopifyPayload>) =>
      Object.assign(new OrdersImportFromShopifyPayload(), {
        orders: 0,
        created: 0,
        skipped: 0,
        linked: 0,
        dryRun: dry,
        userErrors: [],
        ...values,
      });
    const refused = (refusal: { field: string[] | null; code: string; message: string }) =>
      payload({ userErrors: [UserError.of(refusal.field, refusal.code, refusal.message)] });

    const given = storeGiven(store, accessToken, clientId, clientSecret);
    if (!given.ok) return refused(given);
    const read = await readStoreOrders(
      this.shopify.connect(given.shop, given.credentials),
      this.shopify.bulk,
    );
    if (!read.ok) return refused(storeRefusalOf(read));
    const { storeName, orders } = read.value;
    if (orders.length === 0) {
      return refused({ field: ['store'], code: 'BLANK', message: `${storeName} has no orders` });
    }
    if (dry) return payload({ orders: orders.length, created: orders.length });
    const { added, linked } = await this.past.bring(tenant, 'shopify', orders.map(pastOrderOf));
    return payload({
      orders: orders.length,
      created: added,
      skipped: orders.length - added,
      linked,
    });
  }
}

/** A store's order as the shop keeps it among its past orders. */
function pastOrderOf(order: StoreOrder): PastOrderInput {
  return {
    sourceId: order.id,
    name: order.name,
    phone: order.phone,
    email: order.email,
    placedAt: new Date(order.placedAt),
    cancelledAt: order.cancelledAt ? new Date(order.cancelledAt) : null,
    currency: order.currency,
    subtotal: order.subtotal,
    shipping: order.shipping,
    discounts: order.discounts,
    total: order.total,
    financialStatus: order.financialStatus,
    fulfillmentStatus: order.fulfillmentStatus,
    lines: order.lines,
    shippingAddress: order.shippingAddress,
    note: order.note,
  };
}
