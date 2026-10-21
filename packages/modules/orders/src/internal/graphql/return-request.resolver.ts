import {
  CurrentTenant,
  PageInfo,
  RequireScopes,
  UserError,
  badUserInput,
  decodeTimeCursor,
  encodeCursor,
  pageSize,
  type TenantContext,
} from '@hatti/api';
import { isUuid, toPublicId } from '@hatti/ids';
import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { ReturnRequestService, type ReturnRequestRecord } from '../return-request.service.js';
import { orderName } from '../rules.js';
import type { ReturnRequestStatusValue } from '../schema.js';
import { toOrder, uuidOf } from './mappers.js';
import { ReturnReason } from './order.types.js';
import {
  ReturnPreference,
  ReturnRequest,
  ReturnRequestApprovePayload,
  ReturnRequestConnection,
  ReturnRequestDeclinePayload,
  ReturnRequestEdge,
  ReturnRequestStatus,
  ReturnRequestsArgs,
} from './return-request.types.js';

/** A request as the API shows it. */
export function toReturnRequest(record: ReturnRequestRecord): ReturnRequest {
  return Object.assign(new ReturnRequest(), {
    id: toPublicId('returnRequest', record.id),
    orderId: toPublicId('order', record.orderId),
    orderName: orderName(record.orderNumber),
    status: record.status.toUpperCase() as ReturnRequestStatus,
    preference: record.preference.toUpperCase() as ReturnPreference,
    note: record.note,
    declineReason: record.declineReason,
    returnId: record.returnId ? toPublicId('return', record.returnId) : null,
    lineItems: record.lines.map((line) => ({
      lineItemId: toPublicId('lineItem', line.lineItemId),
      title: line.title,
      variantTitle: line.variantTitle,
      quantity: line.quantity,
      returnReason: line.reason.toUpperCase() as ReturnReason,
    })),
    createdAt: record.createdAt,
    decidedAt: record.decidedAt,
  });
}

/** Returns shoppers ask for from their orders' pages (ORD-08, ADR-675). */
@Resolver(() => ReturnRequest)
export class ReturnRequestResolver {
  constructor(private readonly requests: ReturnRequestService) {}

  @Query(() => ReturnRequestConnection, {
    description:
      "Returns shoppers asked for from their delivered orders' pages, the oldest first: those " +
      'waiting (REQUESTED) are for staff to approve or decline.',
  })
  @RequireScopes('read_orders')
  async returnRequests(
    @CurrentTenant() tenant: TenantContext,
    @Args() args: ReturnRequestsArgs,
  ): Promise<ReturnRequestConnection> {
    let after: { id: string; at: string } | null = null;
    if (args.after) {
      after = decodeTimeCursor(args.after);
      if (!isUuid(after.id)) throw badUserInput('Invalid cursor');
    }
    const { items, hasNextPage } = await this.requests.list(tenant, {
      status: args.status ? (args.status.toLowerCase() as ReturnRequestStatusValue) : null,
      orderId: args.orderId ? uuidOf('order', args.orderId) : null,
      first: pageSize(args.first),
      after: after && { id: after.id, createdAt: after.at },
    });
    const edges = items.map((record) =>
      Object.assign(new ReturnRequestEdge(), {
        node: toReturnRequest(record),
        cursor: encodeCursor({ id: record.id, at: record.createdAtExactly }),
      }),
    );
    return Object.assign(new ReturnRequestConnection(), {
      edges,
      nodes: edges.map((edge) => edge.node),
      pageInfo: Object.assign(new PageInfo(), {
        hasNextPage,
        endCursor: edges.at(-1)?.cursor ?? null,
      }),
    });
  }

  @Mutation(() => ReturnRequestApprovePayload, {
    description:
      'Approves a return a shopper asked for: it becomes a return of what they asked to send ' +
      "back, coming back to the location given or the order's, as returnCreate records one, " +
      'and the shopper is told.',
  })
  @RequireScopes('write_orders')
  async returnRequestApprove(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
    @Args('locationId', { type: () => ID, nullable: true }) locationId?: string | null,
  ): Promise<ReturnRequestApprovePayload> {
    const result = await this.requests.approve(tenant, uuidOf('returnRequest', id), {
      locationId: locationId ? uuidOf('location', locationId) : null,
    });
    if (!result.ok) {
      return Object.assign(new ReturnRequestApprovePayload(), {
        returnRequest: null,
        return: null,
        order: null,
        userErrors: UserError.list(result.errors),
      });
    }
    const order = toOrder(result.value.order, tenant);
    const returnId = toPublicId('return', result.value.return.id);
    return Object.assign(new ReturnRequestApprovePayload(), {
      returnRequest: toReturnRequest(result.value.request),
      return: order.returns.find((each) => each.id === returnId) ?? null,
      order,
      userErrors: [],
    });
  }

  @Mutation(() => ReturnRequestDeclinePayload, {
    description:
      'Declines a return a shopper asked for, saying why, as they are told (at most 500 ' +
      'characters).',
  })
  @RequireScopes('write_orders')
  async returnRequestDecline(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
    @Args('reason') reason: string,
  ): Promise<ReturnRequestDeclinePayload> {
    const result = await this.requests.decline(tenant, uuidOf('returnRequest', id), reason);
    return Object.assign(new ReturnRequestDeclinePayload(), {
      returnRequest: result.ok ? toReturnRequest(result.value.request) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }
}
