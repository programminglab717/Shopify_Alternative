import { CurrentTenant, type TenantContext } from '@hatti/api';
import { PaymentLink, PaymentLinkService } from '@hatti/checkout/public';
import { tryFromPublicId } from '@hatti/ids';
import { Order, OrderService, toOrder } from '@hatti/orders/public';
import { Args, Int, Parent, ResolveField, Resolver } from '@nestjs/graphql';

/** How many of a link's orders a page of links shows each, unless asked for more. */
const LINK_ORDERS = 10;

/**
 * The orders placed through a payment link (ADR-645): the checkout module keeps which of the
 * link's checkouts became orders, the orders module keeps the orders, and the core puts the two
 * together.
 */
@Resolver(() => PaymentLink)
export class PaymentLinkOrdersResolver {
  constructor(
    private readonly links: PaymentLinkService,
    private readonly orderService: OrderService,
  ) {}

  @ResolveField(() => [Order], {
    description:
      'The orders placed through it, the latest first: as they are now, whatever became of ' +
      'them since. ordersPlaced counts them all.',
  })
  async orders(
    @CurrentTenant() tenant: TenantContext,
    @Parent() link: PaymentLink,
    @Args('first', {
      type: () => Int,
      nullable: true,
      description: `1 to 250; default ${LINK_ORDERS}.`,
    })
    first?: number | null,
  ): Promise<Order[]> {
    const linkId = tryFromPublicId(link.id, 'paymentLink');
    if (!linkId) return [];
    const ids = await this.links.orderIdsOf(tenant, linkId, first ?? LINK_ORDERS);
    if (ids.length === 0) return [];
    const found = await this.orderService.getMany(tenant, ids);
    return ids.flatMap((id) => {
      const record = found.get(id);
      return record ? [toOrder(record, tenant)] : [];
    });
  }
}
