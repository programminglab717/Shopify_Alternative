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
import { Args, Int, Mutation, Query, Resolver } from '@nestjs/graphql';
import { CALENDAR_DAYS_MAX, type MarketingDate as CalendarDate } from '../calendar.js';
import { MarketingCalendarService } from '../calendar.service.js';
import { ConversionsService, type ConversionRecord } from '../conversions.service.js';
import type {
  ConversionMomentValue,
  ConversionPlatformValue,
  ConversionStatusValue,
} from '../meta.js';
import { MetaConversionsService, type MetaConversionsRecord } from '../meta-settings.service.js';
import { TikTokEventsService, type TikTokEventsRecord } from '../tiktok-settings.service.js';
import { GoogleAnalyticsService, type GoogleAnalyticsRecord } from '../google-settings.service.js';
import {
  ConversionEvent,
  ConversionEventConnection,
  ConversionEventEdge,
  ConversionEventsArgs,
  ConversionMoment,
  ConversionPlatform,
  ConversionStatus,
  GoogleAnalytics,
  GoogleAnalyticsDeletePayload,
  GoogleAnalyticsInput,
  GoogleAnalyticsUpdatePayload,
  MetaConversions,
  MetaConversionsDeletePayload,
  MetaConversionsInput,
  MetaConversionsUpdatePayload,
  MarketingDate,
  MarketingMoment,
  TikTokEvents,
  TikTokEventsDeletePayload,
  TikTokEventsInput,
  TikTokEventsUpdatePayload,
} from './marketing.types.js';

@Resolver()
export class MarketingResolver {
  constructor(
    private readonly meta: MetaConversionsService,
    private readonly tiktok: TikTokEventsService,
    private readonly google: GoogleAnalyticsService,
    private readonly conversions: ConversionsService,
    private readonly calendar: MarketingCalendarService,
  ) {}

  @Query(() => [MarketingDate], {
    description:
      "Pakistan's marketing calendar (MKT-16, ADR-484): Ramadan, the Eids, Pakistan Day, " +
      "Mother's Day, 14 August, 11.11, White Friday, 12.12, and the lawn, winter and wedding " +
      "seasons, those to promote for from the shop's today through `days` ahead, soonest " +
      'first, each with a ready-made campaign.',
  })
  @RequireScopes('read_marketing_events')
  async marketingCalendar(
    @CurrentTenant() tenant: TenantContext,
    @Args('days', {
      type: () => Int,
      nullable: true,
      description: `0 to ${CALENDAR_DAYS_MAX}; default 365.`,
    })
    days?: number | null,
  ): Promise<MarketingDate[]> {
    if (days !== null && days !== undefined && (days < 0 || days > CALENDAR_DAYS_MAX)) {
      throw badUserInput(`days must be 0 to ${CALENDAR_DAYS_MAX}`);
    }
    return (await this.calendar.calendar(tenant, days ?? 365)).map(toMarketingDate);
  }

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

  @Query(() => TikTokEvents, {
    nullable: true,
    description: "The shop's TikTok pixel its orders go to (MKT-10); null until it connects one.",
  })
  @RequireScopes('read_pixels')
  async tiktokEvents(@CurrentTenant() tenant: TenantContext): Promise<TikTokEvents | null> {
    const record = await this.tiktok.get(tenant);
    return record && toTikTokEvents(record);
  }

  @Mutation(() => TikTokEventsUpdatePayload, {
    description:
      "Connects the shop's TikTok pixel, or changes how its orders go to it (ADR-541): from " +
      "then on, each order placed through checkout goes to TikTok's Events API as it is " +
      "placed, confirmed and delivered, its customer's details hashed. Audited, the token " +
      'never. Staff confirm who they are first when they signed in over 15 minutes ago.',
  })
  @RequireScopes('write_pixels')
  @RequireRecentAuthentication()
  async tiktokEventsUpdate(
    @CurrentTenant() tenant: TenantContext,
    @Args('input') input: TikTokEventsInput,
  ): Promise<TikTokEventsUpdatePayload> {
    const result = await this.tiktok.update(tenant, {
      pixelCode: input.pixelCode,
      accessToken: input.accessToken,
      ...(input.testEventCode !== undefined && { testEventCode: input.testEventCode }),
      purchaseAt: input.purchaseAt
        ? (input.purchaseAt.toLowerCase() as ConversionMomentValue)
        : null,
    });
    return Object.assign(new TikTokEventsUpdatePayload(), {
      tiktokEvents: result.ok ? toTikTokEvents(result.value) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Mutation(() => TikTokEventsDeletePayload, {
    description:
      "Disconnects the shop's TikTok pixel: its token is forgotten, and moments still waiting " +
      'are not sent.',
  })
  @RequireScopes('write_pixels')
  async tiktokEventsDelete(
    @CurrentTenant() tenant: TenantContext,
  ): Promise<TikTokEventsDeletePayload> {
    return Object.assign(new TikTokEventsDeletePayload(), {
      deletedPixelCode: await this.tiktok.delete(tenant),
      userErrors: [],
    });
  }

  @Query(() => GoogleAnalytics, {
    nullable: true,
    description:
      "The shop's Google Analytics web stream its orders go to (MKT-10); null until it connects one.",
  })
  @RequireScopes('read_pixels')
  async googleAnalytics(@CurrentTenant() tenant: TenantContext): Promise<GoogleAnalytics | null> {
    const record = await this.google.get(tenant);
    return record && toGoogleAnalytics(record);
  }

  @Mutation(() => GoogleAnalyticsUpdatePayload, {
    description:
      "Connects the shop's Google Analytics web stream, or changes how its orders go to it " +
      '(ADR-547): from then on, each order placed through checkout goes to the Measurement ' +
      "Protocol as it is placed, confirmed and delivered, its customer's details hashed. " +
      'Audited, the secret never. Staff confirm who they are first when they signed in over 15 ' +
      'minutes ago.',
  })
  @RequireScopes('write_pixels')
  @RequireRecentAuthentication()
  async googleAnalyticsUpdate(
    @CurrentTenant() tenant: TenantContext,
    @Args('input') input: GoogleAnalyticsInput,
  ): Promise<GoogleAnalyticsUpdatePayload> {
    const result = await this.google.update(tenant, {
      measurementId: input.measurementId,
      apiSecret: input.apiSecret,
      purchaseAt: input.purchaseAt
        ? (input.purchaseAt.toLowerCase() as ConversionMomentValue)
        : null,
    });
    return Object.assign(new GoogleAnalyticsUpdatePayload(), {
      googleAnalytics: result.ok ? toGoogleAnalytics(result.value) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Mutation(() => GoogleAnalyticsDeletePayload, {
    description:
      "Disconnects the shop's Google Analytics web stream: its secret is forgotten, and moments " +
      'still waiting are not sent.',
  })
  @RequireScopes('write_pixels')
  async googleAnalyticsDelete(
    @CurrentTenant() tenant: TenantContext,
  ): Promise<GoogleAnalyticsDeletePayload> {
    return Object.assign(new GoogleAnalyticsDeletePayload(), {
      deletedMeasurementId: await this.google.delete(tenant),
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
      platform: args.platform ? (args.platform.toLowerCase() as ConversionPlatformValue) : null,
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

function toTikTokEvents(record: TikTokEventsRecord): TikTokEvents {
  return Object.assign(new TikTokEvents(), {
    pixelCode: record.pixelCode,
    accessTokenHint: record.tokenHint,
    testEventCode: record.testEventCode,
    purchaseAt: record.purchaseAt.toUpperCase() as ConversionMoment,
    updatedAt: record.updatedAt,
  });
}

function toGoogleAnalytics(record: GoogleAnalyticsRecord): GoogleAnalytics {
  return Object.assign(new GoogleAnalytics(), {
    measurementId: record.measurementId,
    apiSecretHint: record.secretHint,
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

function toMarketingDate(date: CalendarDate): MarketingDate {
  return Object.assign(new MarketingDate(), {
    moment: date.moment as MarketingMoment,
    startsOn: date.startsOn,
    endsOn: date.endsOn,
    promoteFrom: date.promoteFrom,
    expected: date.expected,
    kit: {
      code: date.kit.code,
      percentage: date.kit.percentage,
      messageEnglish: date.kit.message.en,
      messageUrdu: date.kit.message.ur,
    },
  });
}
