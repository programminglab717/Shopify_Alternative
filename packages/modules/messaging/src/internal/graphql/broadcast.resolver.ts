import {
  CurrentTenant,
  PageInfo,
  RequireScopes,
  UserError,
  badUserInput,
  decodeCursor,
  encodeCursor,
  pageSize,
  type TenantContext,
} from '@hatti/api';
import { isUuid, toPublicId, tryFromPublicId } from '@hatti/ids';
import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { BroadcastsService, type BroadcastRecord } from '../broadcasts.service.js';
import {
  Broadcast,
  BroadcastConnection,
  BroadcastCounts,
  BroadcastEdge,
  BroadcastInput,
  BroadcastPayload,
  BroadcastsArgs,
  BroadcastStatus,
} from './broadcast.types.js';
import type { MessageLanguage } from './messaging.types.js';

@Resolver()
export class BroadcastResolver {
  constructor(private readonly service: BroadcastsService) {}

  @Query(() => BroadcastConnection, {
    description: "The shop's WhatsApp broadcasts, the latest first, with how each went.",
  })
  @RequireScopes('read_marketing_events')
  async broadcasts(
    @CurrentTenant() tenant: TenantContext,
    @Args() args: BroadcastsArgs,
  ): Promise<BroadcastConnection> {
    let after: string | null = null;
    if (args.after) {
      after = decodeCursor(args.after, ['id']).id;
      if (!isUuid(after)) throw badUserInput('Invalid cursor');
    }
    const { items, hasNextPage } = await this.service.list(tenant, {
      first: pageSize(args.first),
      after,
    });
    const edges = items.map((record) =>
      Object.assign(new BroadcastEdge(), {
        node: toBroadcast(record),
        cursor: encodeCursor({ id: record.id }),
      }),
    );
    return Object.assign(new BroadcastConnection(), {
      edges,
      nodes: edges.map((edge) => edge.node),
      pageInfo: Object.assign(new PageInfo(), {
        hasNextPage,
        endCursor: edges.at(-1)?.cursor ?? null,
      }),
    });
  }

  @Query(() => Broadcast, { nullable: true })
  @RequireScopes('read_marketing_events')
  async broadcast(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<Broadcast | null> {
    const uuid = tryFromPublicId(id, 'broadcast');
    if (!uuid) return null;
    const record = await this.service.get(tenant, uuid);
    return record && toBroadcast(record);
  }

  @Mutation(() => BroadcastPayload, {
    description:
      "Schedules a broadcast of one of the shop's approved templates, to a segment's customers " +
      'who agreed to hear from it on WhatsApp, or to all who did: now, or up to 30 days ahead.',
  })
  @RequireScopes('write_marketing_events')
  async broadcastCreate(
    @CurrentTenant() tenant: TenantContext,
    @Args('input') input: BroadcastInput,
  ): Promise<BroadcastPayload> {
    const templateId = tryFromPublicId(input.templateId, 'whatsAppTemplate');
    if (!templateId) throw badUserInput(`Invalid template id: ${input.templateId.slice(0, 64)}`);
    let segmentId: string | null = null;
    if (input.segmentId) {
      segmentId = tryFromPublicId(input.segmentId, 'segment');
      if (!segmentId) throw badUserInput(`Invalid segment id: ${input.segmentId.slice(0, 64)}`);
    }
    const result = await this.service.create(tenant, {
      name: input.name,
      templateId,
      segmentId,
      sendAt: input.sendAt ?? null,
    });
    return payload(result);
  }

  @Mutation(() => BroadcastPayload, {
    description:
      'Cancels a broadcast not yet sent: one being queued stops, and its messages not yet sent ' +
      'are not.',
  })
  @RequireScopes('write_marketing_events')
  async broadcastCancel(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<BroadcastPayload> {
    const uuid = tryFromPublicId(id, 'broadcast');
    if (!uuid) throw badUserInput(`Invalid broadcast id: ${id.slice(0, 64)}`);
    return payload(await this.service.cancel(tenant, uuid));
  }
}

function payload(
  result:
    | { ok: true; value: BroadcastRecord }
    | { ok: false; errors: Parameters<typeof UserError.list>[0] },
): BroadcastPayload {
  return Object.assign(new BroadcastPayload(), {
    broadcast: result.ok ? toBroadcast(result.value) : null,
    userErrors: result.ok ? [] : UserError.list(result.errors),
  });
}

export function toBroadcast(record: BroadcastRecord): Broadcast {
  return Object.assign(new Broadcast(), {
    ...record,
    id: toPublicId('broadcast', record.id),
    templateId: toPublicId('whatsAppTemplate', record.templateId),
    templateLanguage: record.templateLanguage.toUpperCase() as MessageLanguage,
    segmentId: record.segmentId && toPublicId('segment', record.segmentId),
    status: record.status.toUpperCase() as BroadcastStatus,
    counts: Object.assign(new BroadcastCounts(), record.counts),
  });
}
