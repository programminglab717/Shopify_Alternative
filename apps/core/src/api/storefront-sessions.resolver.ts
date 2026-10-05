import {
  CurrentTenant,
  RequireScopes,
  badUserInput,
  shopProfile,
  type TenantContext,
} from '@hatti/api';
import { Database } from '@hatti/db';
import {
  SESSION_REPORT_LIMITS,
  SessionDaysService,
  conversionRate,
  type SessionCounts,
  type SessionIntervalValue,
} from '@hatti/online-store/public';
import { SalesInterval } from '@hatti/orders/public';
import { StorefrontActivity, localDay } from '@hatti/storefront-data';
import { Inject } from '@nestjs/common';
import {
  Args,
  ArgsType,
  Field,
  Float,
  GraphQLISODateTime,
  Int,
  ObjectType,
  Query,
  Resolver,
} from '@nestjs/graphql';
import type { Redis } from 'ioredis';
import { REDIS } from './constants.js';

@ObjectType({
  description:
    "Sessions on the online store, and how far they went, as Shopify's conversion funnel counts " +
    "them (ANL-02, ADR-180). A session is a browser's visit, its pages with no half hour between " +
    'them, counted on each day it saw a page; robots and staff previews are left out. Counts are ' +
    'estimates, within about 1%.',
})
export class StorefrontSessions {
  @Field(() => Int)
  sessions!: number;

  @Field(() => Int, { description: 'Sessions that added to the cart.' })
  addedToCart!: number;

  @Field(() => Int, { description: 'Sessions that reached checkout.' })
  reachedCheckout!: number;

  @Field(() => Int, { description: 'Sessions that placed an order.' })
  converted!: number;

  @Field(() => Float, {
    nullable: true,
    description: 'Converted sessions over sessions, 0 to 1, to four places; null without sessions.',
  })
  conversionRate!: number | null;
}

@ObjectType({ description: "A day's, week's or month's sessions." })
export class StorefrontSessionsPeriod {
  @Field(() => GraphQLISODateTime, {
    description: "When the day, week or month starts, in the shop's time zone.",
  })
  start!: Date;

  @Field(() => StorefrontSessions)
  sessions!: StorefrontSessions;
}

@ObjectType({ description: "A period's sessions on the online store (ANL-02)." })
export class StorefrontSessionsReport {
  @Field(() => [StorefrontSessionsPeriod], {
    description: 'Every day, week or month of the period, those without sessions included.',
  })
  periods!: StorefrontSessionsPeriod[];

  @Field(() => StorefrontSessions)
  totals!: StorefrontSessions;
}

@ObjectType({
  description: 'Who is on the online store now, and its sessions today so far (ANL-02, ADR-180).',
})
export class StorefrontLiveView {
  @Field(() => Int, { description: 'Sessions that saw a page in the last five minutes.' })
  visitorsNow!: number;

  @Field(() => StorefrontSessions, {
    description: "Today's, in the shop's time zone from its midnight, as counted this moment.",
  })
  today!: StorefrontSessions;
}

@ArgsType()
export class StorefrontSessionsArgs {
  @Field(() => GraphQLISODateTime, {
    description: "Sessions from the day this falls on, in the shop's time zone.",
  })
  from!: Date;

  @Field(() => GraphQLISODateTime, {
    description:
      `Sessions to the day before this falls on; at most ${SESSION_REPORT_LIMITS.days} days ` +
      'after from. Sessions are counted by the day: the first and last days count whole.',
  })
  before!: Date;

  @Field(() => SalesInterval, { defaultValue: SalesInterval.DAY })
  interval!: SalesInterval;
}

const toSessions = (counts: SessionCounts): StorefrontSessions =>
  Object.assign(new StorefrontSessions(), { ...counts, conversionRate: conversionRate(counts) });

@Resolver()
export class StorefrontSessionsResolver {
  constructor(
    private readonly days: SessionDaysService,
    private readonly db: Database,
    @Inject(REDIS) private readonly redis: Redis | null,
  ) {}

  @Query(() => StorefrontSessionsReport, {
    description:
      "The online store's sessions over a period (ANL-02): day by day, week by week or month by " +
      "month in the shop's time zone, and how many of them added to the cart, reached checkout " +
      'and placed an order. Kept from the storefronts every minute.',
  })
  @RequireScopes('read_orders')
  async storefrontSessions(
    @CurrentTenant() tenant: TenantContext,
    @Args() args: StorefrontSessionsArgs,
  ): Promise<StorefrontSessionsReport> {
    const result = await this.days.report(tenant, {
      from: args.from,
      before: args.before,
      interval: args.interval.toLowerCase() as SessionIntervalValue,
    });
    if (!result.ok) throw badUserInput(result.errors[0]!.message);
    return Object.assign(new StorefrontSessionsReport(), {
      totals: toSessions(result.value.totals),
      periods: result.value.periods.map((period) =>
        Object.assign(new StorefrontSessionsPeriod(), {
          start: period.start,
          sessions: toSessions(period),
        }),
      ),
    });
  }

  @Query(() => StorefrontLiveView, {
    description:
      "Who is on the online store now, and today's sessions so far, from the storefronts' " +
      'counts as they stand (ANL-02).',
  })
  @RequireScopes('read_orders')
  async storefrontLiveView(@CurrentTenant() tenant: TenantContext): Promise<StorefrontLiveView> {
    const { shopId } = tenant;
    const now = new Date();
    const { timezone } = await this.db.tenant(shopId, (tx) => shopProfile(tx, shopId));
    const activity = this.redis ? new StorefrontActivity(this.redis) : null;
    const counts = activity ? await activity.counts(shopId, localDay(now, timezone)) : null;
    return Object.assign(new StorefrontLiveView(), {
      visitorsNow: activity ? await activity.liveVisitors(shopId, now) : 0,
      today: toSessions({
        sessions: counts?.sessions ?? 0,
        addedToCart: counts?.added_to_cart ?? 0,
        reachedCheckout: counts?.reached_checkout ?? 0,
        converted: counts?.converted ?? 0,
      }),
    });
  }
}
