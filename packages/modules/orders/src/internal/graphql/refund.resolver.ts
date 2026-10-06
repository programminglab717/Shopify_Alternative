import {
  CurrentTenant,
  RequireIdempotencyKey,
  RequireScopes,
  UserError,
  accessDenied,
  deniedToRole,
  hasScope,
  type StaffRole,
  type TenantContext,
} from '@hatti/api';
import type { CurrencyCode } from '@hatti/money';
import { Args, ID, Mutation, Resolver } from '@nestjs/graphql';
import { RefundService } from '../refund.service.js';
import { toOrder, toRefund, toRefundMethodValue, uuidOf } from './mappers.js';
import { OrderRefundInput, OrderRefundPayload, RefundMethod } from './order.types.js';

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
      'Send it, then record it here; or, by ONLINE, Hatti asks the payment gateway the customer ' +
      'paid through to send it, and records it once the gateway says it is sent (ADR-153). The ' +
      'financial status becomes REFUNDED or PARTIALLY_REFUNDED; a completed order stays ' +
      'completed. By STORE_CREDIT, no money moves: the customer is credited it to spend on ' +
      'later orders (ADR-184). Money staff sent may keep its receipt (ADR-242). Staff need to ' +
      'be an owner or a manager. Needs an Idempotency-Key header.',
  })
  @RequireScopes('write_orders')
  @RequireIdempotencyKey()
  async orderRefund(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: OrderRefundInput,
  ): Promise<OrderRefundPayload> {
    if (tenant.actor.kind === 'staff' && !REFUND_ROLES.includes(tenant.actor.role)) {
      throw deniedToRole('Access denied. Only owners and managers refund orders.');
    }
    // Store credit is the shop's to give as its scope says, refund or not (ADR-184).
    if (
      input.method === RefundMethod.STORE_CREDIT &&
      !hasScope(tenant, 'write_store_credit_account_transactions')
    ) {
      throw accessDenied(['write_store_credit_account_transactions']);
    }
    const result = await this.refunds.refund(tenant, uuidOf('order', id), {
      ...input,
      method: toRefundMethodValue(input.method),
    });
    if (!result.ok) {
      return Object.assign(new OrderRefundPayload(), {
        order: null,
        refund: null,
        userErrors: UserError.list(result.errors),
      });
    }
    const { order, refund } = result.value;
    return Object.assign(new OrderRefundPayload(), {
      order: toOrder(order, tenant),
      refund: toRefund(
        refund,
        order.currency as CurrencyCode,
        order.number,
        order.refunds.findIndex((each) => each.id === refund.id) + 1,
      ),
      userErrors: [],
    });
  }
}
