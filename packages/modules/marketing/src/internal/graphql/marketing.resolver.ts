import {
  CurrentTenant,
  PageInfo,
  RequireRecentAuthentication,
  RequireScopes,
  Money,
  UserError,
  badUserInput,
  decodeTimeCursor,
  encodeCursor,
  pageSize,
  type TenantContext,
} from '@hatti/api';
import { isUuid, toPublicId, tryFromPublicId } from '@hatti/ids';
import { money } from '@hatti/money';
import { Args, Int, Mutation, Query, Resolver } from '@nestjs/graphql';
import {
  AdSpendService,
  type AdSpendPlatformValue,
  type AdSpendSourceValue,
} from '../ad-spend.service.js';
import { CALENDAR_DAYS_MAX, type MarketingDate as CalendarDate } from '../calendar.js';
import { MarketingCalendarService } from '../calendar.service.js';
import { ConversionsService, type ConversionRecord } from '../conversions.service.js';
import type {
  ConversionMomentValue,
  ConversionPlatformValue,
  ConversionStatusValue,
} from '../meta.js';
import { MetaAdAccountService, type MetaAdAccountRecord } from '../meta-ad-account.service.js';
import { MetaConversionsService, type MetaConversionsRecord } from '../meta-settings.service.js';
import {
  TikTokAdAccountService,
  type TikTokAdAccountRecord,
} from '../tiktok-ad-account.service.js';
import { TikTokEventsService, type TikTokEventsRecord } from '../tiktok-settings.service.js';
import { GoogleAnalyticsService, type GoogleAnalyticsRecord } from '../google-settings.service.js';
import {
  AdSpendEntry,
  AdSpendInput,
  AdSpendPlatform,
  AdSpendSetPayload,
  AdSpendSource,
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
  MetaAdAccount,
  MetaAdAccountConnectInput,
  MetaAdAccountConnectPayload,
  MetaAdAccountDisconnectPayload,
  MetaAdSpendSyncPayload,
  MetaConversions,
  MetaConversionsDeletePayload,
  MetaConversionsInput,
  MetaConversionsUpdatePayload,
  MarketingDate,
  MarketingMoment,
  TikTokAdAccount,
  TikTokAdAccountConnectInput,
  TikTokAdAccountConnectPayload,
  TikTokAdAccountDisconnectPayload,
  TikTokAdSpendSyncPayload,
  TikTokEvents,
  TikTokEventsDeletePayload,
  TikTokEventsInput,
  TikTokEventsUpdatePayload,
} from './marketing.types.js';

/** Where a day's spend came from, as the Admin API names it. */
const SOURCES: Record<AdSpendSourceValue, AdSpendSource> = {
  manual: AdSpendSource.MANUAL,
  meta_api: AdSpendSource.META,
  tiktok_api: AdSpendSource.TIKTOK,
};

@Resolver()
export class MarketingResolver {
  constructor(
    private readonly meta: MetaConversionsService,
    private readonly tiktok: TikTokEventsService,
    private readonly google: GoogleAnalyticsService,
    private readonly conversions: ConversionsService,
    private readonly calendar: MarketingCalendarService,
    private readonly adSpend: AdSpendService,
    private readonly adAccounts: MetaAdAccountService,
    private readonly advertisers: TikTokAdAccountService,
  ) {}

  @Query(() => [AdSpendEntry], {
    description:
      'What the shop spent on its ads (ADR-553) from one day to another in its time zone, both ' +
      'included, at most 366 days, the latest first.',
  })
  @RequireScopes('read_pixels')
  async adSpendEntries(
    @CurrentTenant() tenant: TenantContext,
    @Args('from', { description: 'The first day, as 2026-10-01.' }) from: string,
    @Args('to', { description: 'The last day, as 2026-10-31.' }) to: string,
  ): Promise<AdSpendEntry[]> {
    const result = await this.adSpend.list(tenant, from, to);
    if (!result.ok) throw badUserInput(result.errors[0]!.message);
    return result.value.map((entry) =>
      Object.assign(new AdSpendEntry(), {
        platform: entry.platform.toUpperCase() as AdSpendPlatform,
        day: entry.day,
        campaign: entry.campaign,
        amount: Money.from(money(entry.amount, tenant.currency)),
        source: SOURCES[entry.source],
      }),
    );
  }

  @Mutation(() => AdSpendSetPayload, {
    description:
      'Records what the shop spent on its ads (ADR-553), day by day, by platform and, where it ' +
      "says, by campaign as its links' utm_campaign names it: each replaces what that day had, " +
      "and an amount of 0 takes it away. The sales report takes it off the orders' profit. At " +
      'most 400 at a time, all or none.',
  })
  @RequireScopes('write_pixels')
  async adSpendSet(
    @CurrentTenant() tenant: TenantContext,
    @Args('entries', { type: () => [AdSpendInput] }) entries: AdSpendInput[],
  ): Promise<AdSpendSetPayload> {
    const result = await this.adSpend.set(
      tenant,
      entries.map((entry) => ({
        platform: entry.platform.toLowerCase() as AdSpendPlatformValue,
        day: entry.day,
        campaign: entry.campaign ?? null,
        amount: entry.amount,
      })),
    );
    return Object.assign(new AdSpendSetPayload(), {
      count: result.ok ? result.value : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Query(() => MetaAdAccount, {
    nullable: true,
    description:
      "The shop's Meta ad account its spend is pulled from (ADR-564); null until it connects one.",
  })
  @RequireScopes('read_pixels')
  async metaAdAccount(@CurrentTenant() tenant: TenantContext): Promise<MetaAdAccount | null> {
    const record = await this.adAccounts.get(tenant);
    return record && toMetaAdAccount(record);
  }

  @Mutation(() => MetaAdAccountConnectPayload, {
    description:
      "Connects the shop's Meta ad account, in place of any it had, or gives it another token " +
      "(ADR-564), once Meta says the token reads it and that it bills in the shop's currency: " +
      'from then on, the worker pulls its spend by day and campaign every few hours, the last ' +
      "week's again each time, and the last 30 days' at once. What the shop typed by hand stays " +
      'its own. On plans with true profit. Audited, the token never. Staff confirm who they are ' +
      'first when they signed in over 15 minutes ago.',
  })
  @RequireScopes('write_pixels')
  @RequireRecentAuthentication()
  async metaAdAccountConnect(
    @CurrentTenant() tenant: TenantContext,
    @Args('input') input: MetaAdAccountConnectInput,
  ): Promise<MetaAdAccountConnectPayload> {
    const result = await this.adAccounts.connect(tenant, {
      adAccountId: input.adAccountId,
      accessToken: input.accessToken,
    });
    return Object.assign(new MetaAdAccountConnectPayload(), {
      metaAdAccount: result.ok ? toMetaAdAccount(result.value) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Mutation(() => MetaAdAccountDisconnectPayload, {
    description:
      "Disconnects the shop's Meta ad account: its token is forgotten, and no more spend is " +
      'pulled. What was pulled stays.',
  })
  @RequireScopes('write_pixels')
  async metaAdAccountDisconnect(
    @CurrentTenant() tenant: TenantContext,
  ): Promise<MetaAdAccountDisconnectPayload> {
    return Object.assign(new MetaAdAccountDisconnectPayload(), {
      deletedAdAccountId: await this.adAccounts.disconnect(tenant),
      userErrors: [],
    });
  }

  @Mutation(() => MetaAdSpendSyncPayload, {
    description:
      "Pulls the shop's spend from its Meta ad account now, as the worker does every few hours " +
      '(ADR-564): at most once a minute.',
  })
  @RequireScopes('write_pixels')
  async metaAdSpendSync(@CurrentTenant() tenant: TenantContext): Promise<MetaAdSpendSyncPayload> {
    const result = await this.adAccounts.pull(tenant);
    return Object.assign(new MetaAdSpendSyncPayload(), {
      metaAdAccount: result.ok ? toMetaAdAccount(result.value) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Query(() => TikTokAdAccount, {
    nullable: true,
    description:
      "The shop's TikTok advertiser account its spend is pulled from (ADR-566); null until it " +
      'connects one.',
  })
  @RequireScopes('read_pixels')
  async tiktokAdAccount(@CurrentTenant() tenant: TenantContext): Promise<TikTokAdAccount | null> {
    const record = await this.advertisers.get(tenant);
    return record && toTikTokAdAccount(record);
  }

  @Mutation(() => TikTokAdAccountConnectPayload, {
    description:
      "Connects the shop's TikTok advertiser account, in place of any it had, or gives it another " +
      "token (ADR-566), once TikTok says the token reads it and that it bills in the shop's " +
      'currency: from then on, the worker pulls its spend by day and campaign every few hours, ' +
      "the last week's again each time, and the last 30 days' at once, as a Meta ad account's. " +
      'What the shop typed by hand stays its own. On plans with true profit. Audited, the token ' +
      'never. Staff confirm who they are first when they signed in over 15 minutes ago.',
  })
  @RequireScopes('write_pixels')
  @RequireRecentAuthentication()
  async tiktokAdAccountConnect(
    @CurrentTenant() tenant: TenantContext,
    @Args('input') input: TikTokAdAccountConnectInput,
  ): Promise<TikTokAdAccountConnectPayload> {
    const result = await this.advertisers.connect(tenant, {
      advertiserId: input.advertiserId,
      accessToken: input.accessToken,
    });
    return Object.assign(new TikTokAdAccountConnectPayload(), {
      tiktokAdAccount: result.ok ? toTikTokAdAccount(result.value) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Mutation(() => TikTokAdAccountDisconnectPayload, {
    description:
      "Disconnects the shop's TikTok advertiser account: its token is forgotten, and no more " +
      'spend is pulled. What was pulled stays.',
  })
  @RequireScopes('write_pixels')
  async tiktokAdAccountDisconnect(
    @CurrentTenant() tenant: TenantContext,
  ): Promise<TikTokAdAccountDisconnectPayload> {
    return Object.assign(new TikTokAdAccountDisconnectPayload(), {
      deletedAdvertiserId: await this.advertisers.disconnect(tenant),
      userErrors: [],
    });
  }

  @Mutation(() => TikTokAdSpendSyncPayload, {
    description:
      "Pulls the shop's spend from its TikTok advertiser account now, as the worker does every " +
      'few hours (ADR-566): at most once a minute.',
  })
  @RequireScopes('write_pixels')
  async tiktokAdSpendSync(
    @CurrentTenant() tenant: TenantContext,
  ): Promise<TikTokAdSpendSyncPayload> {
    const result = await this.advertisers.pull(tenant);
    return Object.assign(new TikTokAdSpendSyncPayload(), {
      tiktokAdAccount: result.ok ? toTikTokAdAccount(result.value) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

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

function toMetaAdAccount(record: MetaAdAccountRecord): MetaAdAccount {
  return Object.assign(new MetaAdAccount(), {
    adAccountId: record.adAccountId,
    name: record.name,
    currency: record.currency,
    timezone: record.timezone,
    accessTokenHint: record.tokenHint,
    lastSyncedAt: record.lastSyncedAt,
    lastError: record.lastError,
    updatedAt: record.updatedAt,
  });
}

function toTikTokAdAccount(record: TikTokAdAccountRecord): TikTokAdAccount {
  return Object.assign(new TikTokAdAccount(), {
    advertiserId: record.advertiserId,
    name: record.name,
    currency: record.currency,
    timezone: record.timezone,
    accessTokenHint: record.tokenHint,
    lastSyncedAt: record.lastSyncedAt,
    lastError: record.lastError,
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
