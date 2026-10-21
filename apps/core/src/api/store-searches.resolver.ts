import {
  CurrentTenant,
  RequireScopes,
  badUserInput,
  shopProfile,
  type TenantContext,
} from '@hatti/api';
import { Database } from '@hatti/db';
import {
  SEARCHES,
  StorefrontSearches,
  localDay,
  type SearchCount,
  type SearchCounts,
} from '@hatti/storefront-data';
import { Inject } from '@nestjs/common';
import { Args, ArgsType, Field, Float, Int, ObjectType, Query, Resolver } from '@nestjs/graphql';
import type { Redis } from 'ioredis';
import { REDIS } from './constants.js';

// What shoppers search the online store for (SRC-06, ADR-683): the searches their pages
// reported over the last days, to today in the shop's time zone, the most searched first, and
// those that found nothing, which say what shoppers want that the shop does not show them.

/** The searches each list gives. */
export const SEARCH_REPORT_ROWS = 25;

@ObjectType({ description: 'A search on the online store, by its words (ADR-683).' })
export class StoreSearchTerms {
  @Field({ description: 'Its words, in lower case, spaces made one.' })
  terms!: string;

  @Field(() => Int, { description: 'Times shoppers searched them.' })
  searches!: number;

  @Field(() => Int, { description: 'Of those, the times they found nothing.' })
  foundNothing!: number;
}

@ObjectType({
  description: 'What shoppers searched the online store for over the last days (SRC-06, ADR-683).',
})
export class StoreSearches {
  @Field(() => Int, { description: "The days counted, to today in the shop's time zone." })
  days!: number;

  @Field(() => Int, { description: 'Searches in all.' })
  searches!: number;

  @Field(() => Int, { description: 'Searches that found nothing.' })
  foundNothing!: number;

  @Field(() => Float, {
    nullable: true,
    description: 'The share of searches that found nothing, 0 to 1; null without searches.',
  })
  foundNothingRate!: number | null;

  @Field(() => [StoreSearchTerms], {
    description: `The ${SEARCH_REPORT_ROWS} most searched, the most first.`,
  })
  top!: StoreSearchTerms[];

  @Field(() => [StoreSearchTerms], {
    description:
      `The ${SEARCH_REPORT_ROWS} searches that most often found nothing, the most first: ` +
      'products to add, or words to put in titles, tags or translations.',
  })
  nothingFound!: StoreSearchTerms[];
}

@ArgsType()
class StoreSearchesArgs {
  @Field(() => Int, {
    defaultValue: 30,
    description: `The days to count, to today: 1 to ${SEARCHES.keepDays}.`,
  })
  days!: number;
}

/** The `days` days ending with `today`, "2026-10-21", the latest first. */
export function searchDays(today: string, days: number): string[] {
  const end = Date.parse(`${today}T00:00:00Z`);
  return Array.from({ length: days }, (_, back) =>
    new Date(end - back * 86_400_000).toISOString().slice(0, 10),
  );
}

const byWords = (a: SearchCount, b: SearchCount) => (a.terms < b.terms ? -1 : 1);

/** The report of `counts` over `days` days. */
export function storeSearchesOf(counts: SearchCounts, days: number): StoreSearches {
  const row = (each: SearchCount) => Object.assign(new StoreSearchTerms(), each);
  return Object.assign(new StoreSearches(), {
    days,
    searches: counts.searches,
    foundNothing: counts.foundNothing,
    foundNothingRate:
      counts.searches > 0 ? Math.round((counts.foundNothing / counts.searches) * 1e4) / 1e4 : null,
    top: [...counts.terms]
      .sort((a, b) => b.searches - a.searches || byWords(a, b))
      .slice(0, SEARCH_REPORT_ROWS)
      .map(row),
    nothingFound: counts.terms
      .filter((each) => each.foundNothing > 0)
      .sort((a, b) => b.foundNothing - a.foundNothing || byWords(a, b))
      .slice(0, SEARCH_REPORT_ROWS)
      .map(row),
  });
}

@Resolver()
export class StoreSearchesResolver {
  constructor(
    private readonly db: Database,
    @Inject(REDIS) private readonly redis: Redis | null,
  ) {}

  @Query(() => StoreSearches, {
    description:
      'What shoppers searched the online store for over the last days, to today in the ' +
      "shop's time zone (SRC-06, ADR-683): the most searched, and those that found nothing.",
  })
  @RequireScopes('read_orders')
  async storeSearches(
    @CurrentTenant() tenant: TenantContext,
    @Args() args: StoreSearchesArgs,
  ): Promise<StoreSearches> {
    if (!Number.isInteger(args.days) || args.days < 1 || args.days > SEARCHES.keepDays) {
      throw badUserInput(`days must be 1 to ${SEARCHES.keepDays}`);
    }
    const { shopId } = tenant;
    const { timezone } = await this.db.tenant(shopId, (tx) => shopProfile(tx, shopId));
    const days = searchDays(localDay(new Date(), timezone), args.days);
    const counts = this.redis
      ? await new StorefrontSearches(this.redis).counts(shopId, days)
      : { searches: 0, foundNothing: 0, terms: [] };
    return storeSearchesOf(counts, args.days);
  }
}
