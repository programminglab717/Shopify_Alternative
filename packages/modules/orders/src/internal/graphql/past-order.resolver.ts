import {
  CurrentTenant,
  PageInfo,
  RequireScopes,
  encodeCursor,
  pageSize,
  type TenantContext,
} from '@hatti/api';
import { Customer } from '@hatti/customers/public';
import { toPublicId, tryFromPublicId } from '@hatti/ids';
import { maskPkMobile } from '@hatti/pk';
import { Args, ID, Int, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { PastOrderService, majorOf, type PastOrderRecord } from '../past-orders.js';
import { cursorAfter, hidesPhones } from './mappers.js';
import {
  PastOrder,
  PastOrderAddress,
  PastOrderAmount,
  PastOrderConnection,
  PastOrderEdge,
  PastOrderLine,
  PastOrdersArgs,
} from './past-order.types.js';

/** A number as the caller may see it: masked unless they see customers' numbers whole. */
const shownPhone = (phone: string | null, hide: boolean) =>
  phone === null || !hide ? phone : maskPkMobile(phone);

function toPastOrder(record: PastOrderRecord, tenant: TenantContext): PastOrder {
  const hide = hidesPhones(tenant);
  const amount = (minor: bigint) =>
    Object.assign(new PastOrderAmount(), {
      amount: majorOf(minor, record.currency),
      currencyCode: record.currency,
    });
  const address = record.shippingAddress;
  return Object.assign(new PastOrder(), {
    id: toPublicId('pastOrder', record.id),
    source: record.source.toUpperCase(),
    name: record.name,
    customerId: record.customerId && toPublicId('customer', record.customerId),
    phone: shownPhone(record.phone, hide),
    email: record.email,
    placedAt: record.placedAt,
    cancelledAt: record.cancelledAt,
    subtotal: amount(record.subtotal),
    shipping: amount(record.shipping),
    discounts: amount(record.discounts),
    total: amount(record.total),
    financialStatus: record.financialStatus,
    fulfillmentStatus: record.fulfillmentStatus,
    lines: record.lines.map((line) =>
      Object.assign(new PastOrderLine(), {
        title: line.title,
        variantTitle: line.variantTitle,
        sku: line.sku,
        quantity: line.quantity,
        price: amount(line.price),
      }),
    ),
    shippingAddress:
      address &&
      Object.assign(new PastOrderAddress(), { ...address, phone: shownPhone(address.phone, hide) }),
    note: record.note,
  });
}

function toConnection(
  page: { items: PastOrderRecord[]; hasNextPage: boolean },
  tenant: TenantContext,
): PastOrderConnection {
  const nodes = page.items.map((record) => toPastOrder(record, tenant));
  const edges = nodes.map((node, index) =>
    Object.assign(new PastOrderEdge(), {
      node,
      cursor: encodeCursor({ id: page.items[index]!.id }),
    }),
  );
  return Object.assign(new PastOrderConnection(), {
    edges,
    nodes,
    pageInfo: Object.assign(new PageInfo(), {
      hasNextPage: page.hasNextPage,
      endCursor: edges.at(-1)?.cursor ?? null,
    }),
  });
}

/** The shop's past orders (ADR-786): brought from the store it moved from, to look back on. */
@Resolver(() => PastOrder)
export class PastOrderResolver {
  constructor(private readonly service: PastOrderService) {}

  @Query(() => PastOrderConnection, {
    description:
      'Orders from the store the shop moved from (ONB-05, ADR-786), the latest placed first, as ' +
      "ordersImportFromShopify brought them; with customerId, that customer's alone.",
  })
  @RequireScopes('read_orders')
  async pastOrders(
    @CurrentTenant() tenant: TenantContext,
    @Args() args: PastOrdersArgs,
  ): Promise<PastOrderConnection> {
    const customerId = args.customerId ? tryFromPublicId(args.customerId, 'customer') : null;
    if (args.customerId && !customerId) {
      return toConnection({ items: [], hasNextPage: false }, tenant);
    }
    const page = await this.service.list(tenant, {
      first: pageSize(args.first),
      after: cursorAfter(args.after),
      customerId,
    });
    return toConnection(page, tenant);
  }

  @Query(() => PastOrder, { nullable: true })
  @RequireScopes('read_orders')
  async pastOrder(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<PastOrder | null> {
    const uuid = tryFromPublicId(id, 'pastOrder');
    const record = uuid ? await this.service.get(tenant, uuid) : null;
    return record && toPastOrder(record, tenant);
  }
}

/** A customer's orders from the store the shop moved from (ADR-786), on the Customer type. */
@Resolver(() => Customer)
export class CustomerPastOrdersResolver {
  constructor(private readonly service: PastOrderService) {}

  @ResolveField(() => PastOrderConnection, {
    description: 'Their orders from the store the shop moved from (ADR-786), the latest first.',
  })
  @RequireScopes('read_orders')
  async pastOrders(
    @CurrentTenant() tenant: TenantContext,
    @Parent() customer: Customer,
    @Args('first', { type: () => Int, nullable: true }) first?: number | null,
  ): Promise<PastOrderConnection> {
    const page = await this.service.list(tenant, {
      first: pageSize(first, 10),
      customerId: customer.uuid,
    });
    return toConnection(page, tenant);
  }
}
