import { CurrentTenant, RequireScopes, UserError, type TenantContext } from '@hatti/api';
import { Args, ID, Int, Mutation, Resolver } from '@nestjs/graphql';
import { OrderLinkService } from '../order-link.service.js';
import { toOrder, uuidOf } from './mappers.js';
import { Order, OrderLinkCreatePayload } from './order.types.js';

@Resolver(() => Order)
export class OrderLinkResolver {
  constructor(private readonly links: OrderLinkService) {}

  @Mutation(() => OrderLinkCreatePayload, {
    description:
      "A link for the order's customer, to send on WhatsApp or by SMS: a page where they see " +
      'the order and, while a cash-on-delivery order waits for them, confirm it or cancel it. ' +
      'After that it shows how the order is doing, until 30 days after the order ends. A new ' +
      'link replaces the one before.',
  })
  @RequireScopes('write_orders')
  async orderLinkCreate(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
    @Args('expiresInHours', {
      type: () => Int,
      nullable: true,
      description:
        'Makes it stop working after 1 to 720 hours. Without it, the link works until 30 days ' +
        'after the order is closed or cancelled.',
    })
    expiresInHours?: number | null,
  ): Promise<OrderLinkCreatePayload> {
    const result = await this.links.createLink(tenant, uuidOf('order', id), { expiresInHours });
    return Object.assign(new OrderLinkCreatePayload(), {
      order: result.ok ? toOrder(result.value.order, tenant) : null,
      url: result.ok ? result.value.url : null,
      whatsappUrl: result.ok ? result.value.whatsappUrl : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }
}
