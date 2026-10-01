import { CurrentTenant, RequireScopes, UserError, type TenantContext } from '@hatti/api';
import { Args, ID, Mutation, Resolver } from '@nestjs/graphql';
import { OrderEditService } from '../order-edit.service.js';
import { toOrder, uuidOf } from './mappers.js';
import { OrderEditLineItemsInput, OrderEditLineItemsPayload } from './order.types.js';

/** Editing an order's items while it waits to be packed (ORD-04, ADR-131). */
@Resolver()
export class OrderEditResolver {
  constructor(private readonly edits: OrderEditService) {}

  @Mutation(() => OrderEditLineItemsPayload, {
    description:
      "Changes an order's items while it waits to be packed, as its customer asks on the " +
      "confirmation call: lines' quantities changed or taken off, variants added. Lines kept keep " +
      'their prices. Its stock, subtotal, total and sales tax follow, and the cash collected at ' +
      'the door; a cash-on-delivery order is scored again, and waits for review if that makes it ' +
      'risky. Its discount, delivery charge and fee stay as they are. Not once it is packed, has ' +
      'shipped or has refunds, nor to a total below what was paid on it.',
  })
  @RequireScopes('write_orders')
  async orderEditLineItems(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: OrderEditLineItemsInput,
  ): Promise<OrderEditLineItemsPayload> {
    const result = await this.edits.editLineItems(tenant, uuidOf('order', id), {
      setQuantities: input.setQuantities?.map((entry) => ({
        lineItemId: uuidOf('lineItem', entry.lineItemId),
        quantity: entry.quantity,
      })),
      addVariants: input.addVariants?.map((line) => ({
        ...line,
        variantId: uuidOf('variant', line.variantId),
      })),
    });
    return Object.assign(new OrderEditLineItemsPayload(), {
      order: result.ok ? toOrder(result.value, tenant) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }
}
