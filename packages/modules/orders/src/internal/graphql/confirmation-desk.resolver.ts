import { CurrentTenant, RequireScopes, UserError, pageSize, type TenantContext } from '@hatti/api';
import { Args, GraphQLISODateTime, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import {
  ConfirmationDeskService,
  type ConfirmationQueueItem as QueueItemRecord,
} from '../confirmation-desk.service.js';
import type { ConfirmationCallOutcomeValue } from '../schema.js';
import {
  ConfirmationCall,
  ConfirmationCallOutcome,
  ConfirmationQueue,
  ConfirmationQueueArgs,
  ConfirmationQueueItem,
  ConfirmationQueueNextPayload,
  OrderConfirmationCallPayload,
} from './confirmation-desk.types.js';
import { toOrder, uuidOf } from './mappers.js';

@Resolver()
export class ConfirmationDeskResolver {
  constructor(private readonly desk: ConfirmationDeskService) {}

  @Query(() => ConfirmationQueue, {
    description:
      "The Confirmation Desk's queue (COD-04): orders waiting for their customers to confirm " +
      'them, due for a call now, the most urgent first, and how many wait for later.',
  })
  @RequireScopes('read_orders')
  async confirmationQueue(
    @CurrentTenant() tenant: TenantContext,
    @Args() args: ConfirmationQueueArgs,
  ): Promise<ConfirmationQueue> {
    const queue = await this.desk.queue(tenant, { first: pageSize(args.first) });
    return Object.assign(new ConfirmationQueue(), {
      nodes: queue.items.map((item) => toItem(item, tenant)),
      dueCount: queue.dueCount,
      laterCount: queue.laterCount,
    });
  }

  @Mutation(() => ConfirmationQueueNextPayload, {
    description:
      'Deals you the most urgent order due that no one else has taken, yours for 15 minutes, so ' +
      'that no two agents call the same customer; the one you took already while you have it. ' +
      'Confirm or cancel it, or record the call, and ask for the next.',
  })
  @RequireScopes('write_orders')
  async confirmationQueueNext(
    @CurrentTenant() tenant: TenantContext,
  ): Promise<ConfirmationQueueNextPayload> {
    const item = await this.desk.next(tenant);
    return Object.assign(new ConfirmationQueueNextPayload(), {
      item: item ? toItem(item, tenant) : null,
    });
  }

  @Mutation(() => OrderConfirmationCallPayload, {
    description:
      'Records a call made to confirm an order that did not settle it, and lets the order go ' +
      'for the next agent. Confirming and cancelling are orderConfirm and orderCancel.',
  })
  @RequireScopes('write_orders')
  async orderConfirmationCall(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
    @Args('outcome', { type: () => ConfirmationCallOutcome }) outcome: ConfirmationCallOutcome,
    @Args('callBackAt', {
      type: () => GraphQLISODateTime,
      nullable: true,
      description: 'When to call again: needed to CALL_BACK; within 7 days.',
    })
    callBackAt?: Date | null,
    @Args('note', { type: () => String, nullable: true, description: 'Up to 500 characters.' })
    note?: string | null,
  ): Promise<OrderConfirmationCallPayload> {
    const result = await this.desk.recordCall(tenant, uuidOf('order', id), {
      outcome: outcome.toLowerCase() as ConfirmationCallOutcomeValue,
      callBackAt,
      note,
    });
    return Object.assign(new OrderConfirmationCallPayload(), {
      order: result.ok ? toOrder(result.value, tenant) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }
}

function toItem(item: QueueItemRecord, tenant: TenantContext): ConfirmationQueueItem {
  return Object.assign(new ConfirmationQueueItem(), {
    order: toOrder(item.order, tenant),
    unansweredCalls: item.unansweredCalls,
    dueAt: item.dueAt,
    lastCall: item.lastCall
      ? Object.assign(new ConfirmationCall(), {
          ...item.lastCall,
          outcome: item.lastCall.outcome.toUpperCase() as ConfirmationCallOutcome,
        })
      : null,
    claimedUntil: item.claimedUntil,
    claimedByYou: item.claimedByCaller,
  });
}
