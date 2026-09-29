import {
  CurrentTenant,
  Loaders,
  Money,
  RequestLoaders,
  RequireScopes,
  pageSize,
  type TenantContext,
} from '@hatti/api';
import { Customer } from '@hatti/customers/public';
import { money } from '@hatti/money';
import { Args, GraphQLISODateTime, Int, Parent, ResolveField, Resolver } from '@nestjs/graphql';
import { OrderService } from '../order.service.js';
import { NO_ORDERS, type CustomerOrderStats } from '../records.js';
import type { AddressValue } from '../schema.js';
import { cursorAfter, hidesPhones, toAddress, toOrderConnection } from './mappers.js';
import {
  CustomerDeliveryHistory,
  CustomerOrdersArgs,
  MailingAddress,
  OrderConnection,
} from './order.types.js';

/** Addresses per customer. */
const ADDRESS_LIMIT = 10;

/**
 * What the customers module's Customer type shows of their orders. Worked out from the orders when
 * asked for, one query per page of customers.
 */
@Resolver(() => Customer)
export class CustomerOrdersResolver {
  constructor(private readonly service: OrderService) {}

  #stats(tenant: TenantContext, loaders: RequestLoaders, customer: Customer) {
    const loader = loaders.get<string, CustomerOrderStats>('orders.customerStats', (ids) =>
      this.service.customerStats(tenant, ids),
    );
    return loader.load(customer.uuid).then((stats) => stats ?? NO_ORDERS);
  }

  @ResolveField(() => Int, { description: 'Orders placed, cancelled ones included.' })
  @RequireScopes('read_orders')
  async numberOfOrders(
    @CurrentTenant() tenant: TenantContext,
    @Loaders() loaders: RequestLoaders,
    @Parent() customer: Customer,
  ): Promise<number> {
    return (await this.#stats(tenant, loaders, customer)).count;
  }

  @ResolveField(() => Money, {
    description: 'What they have paid on their orders, cancelled ones aside, less refunds.',
  })
  @RequireScopes('read_orders')
  async amountSpent(
    @CurrentTenant() tenant: TenantContext,
    @Loaders() loaders: RequestLoaders,
    @Parent() customer: Customer,
  ): Promise<Money> {
    const stats = await this.#stats(tenant, loaders, customer);
    return Money.from(money(stats.amountSpent, tenant.currency));
  }

  @ResolveField(() => CustomerDeliveryHistory)
  @RequireScopes('read_orders')
  async deliveryHistory(
    @CurrentTenant() tenant: TenantContext,
    @Loaders() loaders: RequestLoaders,
    @Parent() customer: Customer,
  ): Promise<CustomerDeliveryHistory> {
    const stats = await this.#stats(tenant, loaders, customer);
    return Object.assign(new CustomerDeliveryHistory(), {
      delivered: stats.delivered,
      returned: stats.returned,
      cancelled: stats.cancelled,
      inProgress: stats.inProgress,
    });
  }

  @ResolveField(() => GraphQLISODateTime, {
    nullable: true,
    description: 'When they last ordered.',
  })
  @RequireScopes('read_orders')
  async lastOrderAt(
    @CurrentTenant() tenant: TenantContext,
    @Loaders() loaders: RequestLoaders,
    @Parent() customer: Customer,
  ): Promise<Date | null> {
    return (await this.#stats(tenant, loaders, customer)).lastOrderAt;
  }

  @ResolveField(() => OrderConnection, { description: 'Their orders, newest first.' })
  @RequireScopes('read_orders')
  async orders(
    @CurrentTenant() tenant: TenantContext,
    @Parent() customer: Customer,
    @Args() args: CustomerOrdersArgs,
  ): Promise<OrderConnection> {
    const { items, hasNextPage } = await this.service.list(tenant, {
      first: pageSize(args.first),
      after: cursorAfter(args.after),
      customerId: customer.uuid,
    });
    return toOrderConnection(items, hasNextPage, tenant);
  }

  @ResolveField(() => [MailingAddress], {
    description: `Where their orders went, most recently used first: up to ${ADDRESS_LIMIT}.`,
  })
  @RequireScopes('read_orders')
  async addresses(
    @CurrentTenant() tenant: TenantContext,
    @Loaders() loaders: RequestLoaders,
    @Parent() customer: Customer,
  ): Promise<MailingAddress[]> {
    const loader = loaders.get<string, AddressValue[]>('orders.customerAddresses', (ids) =>
      this.service.customerAddresses(tenant, ids, ADDRESS_LIMIT),
    );
    const addresses = (await loader.load(customer.uuid)) ?? [];
    return addresses.map((address) => toAddress(address, hidesPhones(tenant)));
  }
}
