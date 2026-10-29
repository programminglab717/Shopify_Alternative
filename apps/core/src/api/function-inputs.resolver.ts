import { CurrentTenant, RequireScopes, type TenantContext } from '@hatti/api';
import { Database } from '@hatti/db';
import { tryFromPublicId } from '@hatti/ids';
import { Args, ID, Query, Resolver } from '@nestjs/graphql';
import { sql } from 'drizzle-orm';

/** Every way to pay checkout may offer, for the function to choose from. */
const PAYMENT_METHODS = ['cash_on_delivery', 'bank_transfer', 'online'] as const;

/**
 * A function's input made from one of the shop's orders (DEV-07, ADR-950), as checkout would
 * give it had the order's cart been at checkout: its lines, its subtotal and the city and
 * province it went to, with every way to pay checkout may offer, and the calling app's function's
 * settings where its handle is named. For `hatti function run --order`, so that a function is
 * tried on what the shop really sells before it is turned on. No name, number or street of the
 * customer's is in it.
 */
@Resolver()
export class FunctionInputsResolver {
  constructor(private readonly db: Database) {}

  @Query(() => String, {
    nullable: true,
    description:
      "A checkout function's input, as JSON, made from the order: its lines, subtotal, city and " +
      'province, every way to pay checkout may offer, and the settings of the calling app’s ' +
      'function `handle` where named (ADR-950). Null for no such order. Nothing of the ' +
      "customer's but their city and province.",
  })
  @RequireScopes('read_orders')
  async appFunctionInput(
    @CurrentTenant() tenant: TenantContext,
    @Args('orderId', { type: () => ID }) orderId: string,
    @Args('handle', { type: () => String, nullable: true }) handle?: string | null,
  ): Promise<string | null> {
    const id = tryFromPublicId(orderId, 'order');
    if (!id) return null;
    const app = tenant.actor.kind === 'app' ? tenant.actor.tokenId : null;
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows: orders } = await tx.execute<{
        currency: string;
        subtotal: string;
        city: string | null;
        province: string | null;
      }>(sql`
        SELECT currency, subtotal::text, shipping_address ->> 'city' AS city,
               shipping_address ->> 'provinceCode' AS province
          FROM orders.orders WHERE shop_id = ${tenant.shopId} AND id = ${id}`);
      const order = orders[0];
      if (!order) return null;
      const { rows: lines } = await tx.execute<{
        variant_id: string;
        product_id: string;
        title: string;
        variant_title: string;
        sku: string | null;
        quantity: number;
        unit_price: string;
      }>(sql`
        SELECT variant_id, product_id, title, variant_title, sku, quantity, unit_price::text
          FROM orders.lines WHERE shop_id = ${tenant.shopId} AND order_id = ${id}
         ORDER BY position`);
      const { rows: functions } =
        app && handle
          ? await tx.execute<{ configuration: Record<string, unknown> }>(sql`
              SELECT configuration FROM apps.app_functions
               WHERE shop_id = ${tenant.shopId} AND token_id = ${app} AND handle = ${handle}`)
          : { rows: [] };
      const city = order.city?.trim() ?? '';
      return JSON.stringify(
        {
          cart: {
            subtotal: Number(order.subtotal),
            currency: order.currency,
            lines: lines.map((line) => ({
              variantId: line.variant_id,
              productId: line.product_id,
              title: line.title,
              variantTitle: line.variant_title,
              sku: line.sku,
              quantity: line.quantity,
              price: Number(line.unit_price),
            })),
          },
          deliveryAddress: city ? { city, province: order.province ?? '' } : null,
          paymentMethods: PAYMENT_METHODS,
          configuration: functions[0]?.configuration ?? {},
        },
        null,
        2,
      );
    });
  }
}
