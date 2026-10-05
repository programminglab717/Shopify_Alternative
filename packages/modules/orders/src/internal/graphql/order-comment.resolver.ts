import {
  CurrentTenant,
  RequireScopes,
  UserError,
  type StaffRole,
  type TenantContext,
} from '@hatti/api';
import { toPublicId } from '@hatti/ids';
import { Args, ID, Mutation, Resolver } from '@nestjs/graphql';
import { OrderCommentService } from '../order-comment.service.js';
import { LIMITS } from '../rules.js';
import { toOrderEvent, uuidOf } from './mappers.js';
import {
  OrderCommentCreatePayload,
  OrderCommentDeletePayload,
  OrderCommentUpdatePayload,
} from './order.types.js';

/** Staff who delete anyone's comment, as they may anything on an order: owners and managers. */
const MODERATING_ROLES: readonly StaffRole[] = ['owner', 'manager'];

/** Comments on an order's timeline (ORD-02, ADR-128), which `Order.events` reads with the rest. */
@Resolver()
export class OrderCommentResolver {
  constructor(private readonly comments: OrderCommentService) {}

  @Mutation(() => OrderCommentCreatePayload, {
    description:
      "Writes a comment on an order's timeline, as the caller, for whoever picks the order up " +
      `next: up to ${LIMITS.comment.toLocaleString('en')} characters. It changes nothing of the ` +
      'order. Members of staff it names, as @ and their name, are told on WhatsApp (ADR-191).',
  })
  @RequireScopes('write_orders')
  async orderCommentCreate(
    @CurrentTenant() tenant: TenantContext,
    @Args('orderId', { type: () => ID }) orderId: string,
    @Args('message') message: string,
  ): Promise<OrderCommentCreatePayload> {
    const result = await this.comments.create(tenant, uuidOf('order', orderId), message);
    return Object.assign(new OrderCommentCreatePayload(), {
      comment: result.ok ? toOrderEvent(result.value) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Mutation(() => OrderCommentUpdatePayload, {
    description:
      "Changes a comment's words: its author's alone, staff or app. Members of staff it names " +
      'now and did not before are told on WhatsApp (ADR-191).',
  })
  @RequireScopes('write_orders')
  async orderCommentUpdate(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
    @Args('message') message: string,
  ): Promise<OrderCommentUpdatePayload> {
    const result = await this.comments.update(tenant, uuidOf('orderComment', id), message);
    return Object.assign(new OrderCommentUpdatePayload(), {
      comment: result.ok ? toOrderEvent(result.value) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Mutation(() => OrderCommentDeletePayload, {
    description: "Deletes a comment: the caller's own, or, for owners and managers, anyone's.",
  })
  @RequireScopes('write_orders')
  async orderCommentDelete(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<OrderCommentDeletePayload> {
    const commentId = uuidOf('orderComment', id);
    const anyones = tenant.actor.kind === 'staff' && MODERATING_ROLES.includes(tenant.actor.role);
    const result = await this.comments.delete(tenant, commentId, { anyones });
    return Object.assign(new OrderCommentDeletePayload(), {
      deletedCommentId: result.ok ? toPublicId('orderComment', commentId) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }
}
