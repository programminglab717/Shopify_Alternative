import {
  CurrentTenant,
  RequireScopes,
  UserError,
  deniedToRole,
  type StaffRole,
  type TenantContext,
} from '@hatti/api';
import type { CurrencyCode } from '@hatti/money';
import { Args, ID, Mutation, Resolver } from '@nestjs/graphql';
import { RefundService } from '../refund.service.js';
import { toOrder, toRefund, toRefundMethodValue, uuidOf } from './mappers.js';
import { OrderRefundInput, OrderRefundPayload } from './order.types.js';

/**
 * Staff who may refund: owners and managers, whose Orders access is full
 * (docs/design/02-information-architecture.md §6). Apps need only write_orders.
 */
const REFUND_ROLES: readonly StaffRole[] = ['owner', 'manager'];

@Resolver()
export class RefundResolver {
  constructor(private readonly refunds: RefundService) {}

  @Mutation(() => OrderRefundPayload, {
    description:
      'Records money given back on an order, up to what was paid on it and not refunded yet. ' +
      'Hatti moves no money: send it, then record it here. The financial status becomes ' +
      'REFUNDED or PARTIALLY_REFUNDED; a completed order stays completed. Staff need to be an ' +
      'owner or a manager.',
  })
  @RequireScopes('write_orders')
  async orderRefund(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: OrderRefundInput,
  ): Promise<OrderRefundPayload> {
    if (tenant.actor.kind === 'staff' && !REFUND_ROLES.includes(tenant.actor.role)) {
      throw deniedToRole('Access denied. Only owners and managers refund orders.');
    }
    const result = await this.refunds.refund(tenant, uuidOf('order', id), {
      ...input,
      method: toRefundMethodValue(input.method),
    });
    return Object.assign(new OrderRefundPayload(), {
      order: result.ok ? toOrder(result.value.order, tenant) : null,
      refund: result.ok
        ? toRefund(result.value.refund, result.value.order.currency as CurrencyCode)
        : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }
}
