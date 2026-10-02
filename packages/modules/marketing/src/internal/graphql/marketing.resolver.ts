import {
  CurrentTenant,
  PageInfo,
  RequireRecentAuthentication,
  RequireScopes,
  UserError,
  badUserInput,
  decodeTimeCursor,
  encodeCursor,
  pageSize,
  type TenantContext,
} from '@hatti/api';
import { isUuid, toPublicId, tryFromPublicId } from '@hatti/ids';
import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { ConversionsService, type ConversionRecord } from '../conversions.service.js';
import type { ConversionMomentValue, ConversionStatusValue } from '../meta.js';
import { MetaConversionsService, type MetaConversionsRecord } from '../meta-settings.service.js';
import {
  ConversionEvent,
  ConversionEventConnection,
  ConversionEventEdge,
  ConversionEventsArgs,
  ConversionMoment,
  ConversionPlatform,
  ConversionStatus,
  MetaConversions,
  MetaConversionsDeletePayload,
  MetaConversionsInput,
  MetaConversionsUpdatePayload,
} from './marketing.types.js';

@Resolver()
export class MarketingResolver {
  constructor(
    private readonly meta: MetaConversionsService,
    private readonly conversions: ConversionsService,
  ) {}

  @Query(() => MetaConversions, {
    nullable: true,
    description: "The shop's Meta dataset its orders go to (MKT-10); null until it connects one.",
  })
  @RequireScopes('read_pixels')
  async metaConversions(@CurrentTenant() tenant: TenantContext): Promise<MetaConversions | null> {
    const record = await this.meta.get(tenant);
    return record && toMetaConversions(record);
  }

  @Mutation(() => MetaConversionsUpdatePayload, {
    description:
      "Connects the shop's Meta dataset, or changes how its orders go to it (ADR-143): from " +
      'then on, each order placed through checkout goes to Meta as it is placed, confirmed and ' +
      "delivered, its customer's details hashed. Audited, the token never. Staff confirm who " +
      'they are first when they signed in over 15 minutes ago.',
  })
  @RequireScopes('write_pixels')
  @RequireRecentAuthentication()
  async metaConversionsUpdate(
    @CurrentTenant() tenant: TenantContext,
    @Args('input') input: MetaConversionsInput,
  ): Promise<MetaConversionsUpdatePayload> {
    const result = await this.meta.update(tenant, {
      pixelId: input.pixelId,
      accessToken: input.accessToken,
      ...(input.testEventCode !== undefined && { testEventCode: input.testEventCode }),
      purchaseAt: input.purchaseAt
        ? (input.purchaseAt.toLowerCase() as ConversionMomentValue)
        : null,
    });
    return Object.assign(new MetaConversionsUpdatePayload(), {
      metaConversions: result.ok ? toMetaConversions(result.value) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Mutation(() => MetaConversionsDeletePayload, {
    description:
      "Disconnects the shop's Meta dataset: its token is forgotten, and moments still waiting " +
      'are not sent.',
  })
  @RequireScopes('write_pixels')
  async metaConversionsDelete(
    @CurrentTenant() tenant: TenantContext,
  ): Promise<MetaConversionsDeletePayload> {
    return Object.assign(new MetaConversionsDeletePayload(), {
      deletedPixelId: await this.meta.delete(tenant),
      userErrors: [],
    });
  }

  @Query(() => ConversionEventConnection, {
    description:
      "The moments of the shop's orders sent, or to be sent, to the ad platforms it connected, " +
      'the latest first, with how sending each went.',
  })
  @RequireScopes('read_pixels')
  async conversionEvents(
    @CurrentTenant() tenant: TenantContext,
    @Args() args: ConversionEventsArgs,
  ): Promise<ConversionEventConnection> {
    let after: { id: string; at: string } | null = null;
    if (args.after) {
      after = decodeTimeCursor(args.after);
      if (!isUuid(after.id)) throw badUserInput('Invalid cursor');
    }
    let orderId: string | null = null;
    if (args.orderId) {
      orderId = tryFromPublicId(args.orderId, 'order');
      if (!orderId) throw badUserInput(`Invalid order id: ${args.orderId.slice(0, 64)}`);
    }
    const { items, hasNextPage } = await this.conversions.list(tenant, {
      first: pageSize(args.first),
      after: after && { id: after.id, createdAt: after.at },
      status: args.status ? (args.status.toLowerCase() as ConversionStatusValue) : null,
      orderId,
    });
    const edges = items.map((record) =>
      Object.assign(new ConversionEventEdge(), {
        node: toConversionEvent(record),
        cursor: encodeCursor({ id: record.id, at: record.createdAtExactly }),
      }),
    );
    return Object.assign(new ConversionEventConnection(), {
      edges,
      nodes: edges.map((edge) => edge.node),
      pageInfo: Object.assign(new PageInfo(), {
        hasNextPage,
        endCursor: edges.at(-1)?.cursor ?? null,
      }),
    });
  }
}

function toMetaConversions(record: MetaConversionsRecord): MetaConversions {
  return Object.assign(new MetaConversions(), {
    pixelId: record.pixelId,
    accessTokenHint: record.tokenHint,
    testEventCode: record.testEventCode,
    purchaseAt: record.purchaseAt.toUpperCase() as ConversionMoment,
    updatedAt: record.updatedAt,
  });
}

function toConversionEvent(record: ConversionRecord): ConversionEvent {
  return Object.assign(new ConversionEvent(), {
    id: toPublicId('conversionEvent', record.id),
    platform: record.platform.toUpperCase() as ConversionPlatform,
    orderId: toPublicId('order', record.orderId),
    moment: record.moment.toUpperCase() as ConversionMoment,
    occurredAt: record.occurredAt,
    status: record.status.toUpperCase() as ConversionStatus,
    eventName: record.eventName,
    attempts: record.attempts,
    sentAt: record.sentAt,
    error: record.error,
    traceId: record.traceId,
    createdAt: record.createdAt,
  });
}
