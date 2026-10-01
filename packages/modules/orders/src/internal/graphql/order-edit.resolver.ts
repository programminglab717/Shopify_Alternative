import { CurrentTenant, RequireScopes, UserError, type TenantContext } from '@hatti/api';
import { Args, ID, Mutation, Resolver } from '@nestjs/graphql';
import { OrderEditService } from '../order-edit.service.js';
import { toOrder, uuidOf } from './mappers.js';
import {
  OrderEditLineItemsInput,
  OrderEditLineItemsPayload,
  OrderMergePayload,
} from './order.types.js';

/** Editing an order's items while it waits to be packed (ORD-04, ADR-131), and merging two. */
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

  @Mutation(() => OrderMergePayload, {
    description:
      "Merges an order into another of its customer's, as when they placed one order twice, or " +
      'a second for something to go with the first (ADR-132): the order merged into takes its ' +
      'items at the prices they were sold at, its discount and discount codes, and its note and ' +
      'tags where they fit, and keeps its own address, delivery charge and fee, as one parcel; ' +
      'its stock, totals, sales tax and cash to collect follow, and it is scored again. The ' +
      "order merged is cancelled as MERGED, and its customer's link says which order it joined. " +
      'Both wait to be packed and are paid the same way; the order merged has nothing paid or ' +
      'asked for in advance.',
  })
  @RequireScopes('write_orders')
  async orderMerge(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID, description: 'The order to merge.' }) id: string,
    @Args('intoId', { type: () => ID, description: 'The order that takes its items.' })
    intoId: string,
  ): Promise<OrderMergePayload> {
    const result = await this.edits.merge(tenant, uuidOf('order', id), uuidOf('order', intoId));
    return Object.assign(new OrderMergePayload(), {
      order: result.ok ? toOrder(result.value.order, tenant) : null,
      mergedOrder: result.ok ? toOrder(result.value.merged, tenant) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }
}
