import {
  CurrentTenant,
  Loaders,
  PageInfo,
  RequestLoaders,
  RequireScopes,
  UserError,
  badUserInput,
  decodeCursor,
  encodeCursor,
  pageSize,
  type TenantContext,
} from '@hatti/api';
import { isUuid, toPublicId } from '@hatti/ids';
import { pkDayOf } from '@hatti/pk';
import { Args, ID, Int, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { InventoryService } from '../inventory.service.js';
import {
  LowStockService,
  SALES_PACE_DAYS,
  SEASON_LIMITS,
  FORECAST_WEEKS,
  daysLeft,
  forecastUnits,
  runsOutOn,
  seasonAhead,
  weeklyForecast,
  type SeasonOutlook,
  type InventorySettingsRecord,
  type LowStockCursor,
  type LowStockRecord,
} from '../low-stock.service.js';
import { loadItem } from './inventory.resolver.js';
import { InventoryItem } from './inventory.types.js';
import {
  InventorySettings,
  InventorySettingsInput,
  InventorySettingsUpdatePayload,
  LowStockItem,
  LowStockItemConnection,
  LowStockItemEdge,
  StockSeason,
  StockSeasonKey,
  StockWeek,
} from './low-stock.types.js';
import { toInventoryItem, uuidOf } from './mappers.js';

/** Low stock (INV-01, ADR-125): what the shop calls low, and the variants running low or out. */
@Resolver()
export class LowStockResolver {
  constructor(private readonly lowStock: LowStockService) {}

  @Query(() => InventorySettings, { description: "The shop's inventory settings." })
  @RequireScopes('read_inventory')
  async inventorySettings(@CurrentTenant() tenant: TenantContext): Promise<InventorySettings> {
    return toSettings(await this.lowStock.settings(tenant));
  }

  @Mutation(() => InventorySettingsUpdatePayload, {
    description: 'Changes what the shop calls low stock.',
  })
  @RequireScopes('write_inventory')
  async inventorySettingsUpdate(
    @CurrentTenant() tenant: TenantContext,
    @Args('input') input: InventorySettingsInput,
  ): Promise<InventorySettingsUpdatePayload> {
    const result = await this.lowStock.updateSettings(tenant, {
      ...(input.lowStockThreshold !== undefined && { lowStockThreshold: input.lowStockThreshold }),
    });
    return Object.assign(new InventorySettingsUpdatePayload(), {
      inventorySettings: result.ok ? toSettings(result.value) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Query(() => LowStockItemConnection, {
    description:
      "The shop's variants of active products running low or out of stock, at its threshold: " +
      'the fewest for sale first, to reorder.',
  })
  @RequireScopes('read_inventory')
  async inventoryLowStock(
    @CurrentTenant() tenant: TenantContext,
    @Args('first', { type: () => Int, nullable: true, description: '1 to 250; default 50.' })
    first: number | null,
    @Args('after', { type: () => String, nullable: true }) after: string | null,
    @Args('locationId', {
      type: () => ID,
      nullable: true,
      description:
        'Those stocked at this location before, by what is available there, and on order for it.',
    })
    locationId: string | null,
  ): Promise<LowStockItemConnection> {
    const { items, hasNextPage } = await this.lowStock.list(tenant, {
      first: pageSize(first),
      after: lowStockCursorAfter(after),
      locationId: locationId ? uuidOf('location', locationId) : null,
    });
    const edges = items.map((record) =>
      Object.assign(new LowStockItemEdge(), {
        node: toLowStockItem(record),
        cursor: encodeCursor({ available: String(record.available), id: record.variantId }),
      }),
    );
    return Object.assign(new LowStockItemConnection(), {
      edges,
      nodes: edges.map((edge) => edge.node),
      pageInfo: Object.assign(new PageInfo(), {
        hasNextPage,
        endCursor: edges.at(-1)?.cursor ?? null,
      }),
    });
  }

  @Query(() => StockSeason, {
    nullable: true,
    description:
      'The season on now, or the next to begin within 90 days (INV-08, ADR-863), with how much ' +
      'faster than usual the shop sold in it last year; null for none.',
  })
  @RequireScopes('read_inventory')
  async stockSeason(@CurrentTenant() tenant: TenantContext): Promise<StockSeason | null> {
    const season = seasonAhead();
    if (!season) return null;
    const { shop } = await this.lowStock.seasonLifts(tenant, [], null, season);
    return toStockSeason({ season, lift: shop, fromShop: true });
  }
}

/** A season ahead as the API says it. */
function toStockSeason(outlook: SeasonOutlook): StockSeason {
  return Object.assign(new StockSeason(), {
    key: outlook.season.key.toUpperCase() as StockSeasonKey,
    startsOn: outlook.season.start,
    endsOn: outlook.season.end,
    lift: outlook.lift,
    fromShop: outlook.fromShop,
  });
}

/**
 * The season ahead of a variant (ADR-863), with its own lift last year or else the shop's,
 * through the request's batch loader: a page of variants reads them with one query.
 */
export function loadSeason(
  loaders: RequestLoaders,
  lowStock: LowStockService,
  tenant: TenantContext,
  variantId: string,
  locationId: string | null = null,
): Promise<SeasonOutlook | null> {
  const season = seasonAhead();
  if (!season) return Promise.resolve(null);
  return loaders
    .get<string, SeasonOutlook>(`inventory.season:${locationId ?? 'online'}`, async (ids) => {
      const { shop, variants } = await lowStock.seasonLifts(tenant, ids, locationId, season);
      return new Map(
        ids.map((id) => {
          const own = variants.get(id);
          return [
            id,
            { season, lift: own ?? shop, fromShop: own === undefined && shop !== null },
          ] as const;
        }),
      );
    })
    .load(variantId)
    .then((outlook) => outlook ?? { season, lift: null, fromShop: false });
}

/**
 * What a variant sold in the last 30 days (ADR-368), at `locationId` or at all the shop's
 * locations, through the request's batch loader: a page of variants reads it with one query.
 */
export function loadSold(
  loaders: RequestLoaders,
  lowStock: LowStockService,
  tenant: TenantContext,
  variantId: string,
  locationId: string | null = null,
): Promise<number> {
  return loaders
    .get<string, number>(`inventory.sold:${locationId ?? 'online'}`, (ids) =>
      lowStock.soldOf(tenant, ids, locationId),
    )
    .load(variantId)
    .then((sold) => sold ?? 0);
}

@Resolver(() => LowStockItem)
export class LowStockItemResolver {
  constructor(
    private readonly service: InventoryService,
    private readonly lowStock: LowStockService,
  ) {}

  #sold(tenant: TenantContext, loaders: RequestLoaders, item: LowStockItem): Promise<number> {
    // Listed for one location, what sold from there alone (ADR-359).
    return loadSold(loaders, this.lowStock, tenant, item.record.variantId, item.record.locationId);
  }

  @ResolveField(() => Int, {
    description:
      `Units sold in the last ${SALES_PACE_DAYS} days (INV-08): committed to orders, less those ` +
      'released when orders were cancelled; listed for one location, from there alone.',
  })
  soldLast30Days(
    @CurrentTenant() tenant: TenantContext,
    @Loaders() loaders: RequestLoaders,
    @Parent() item: LowStockItem,
  ): Promise<number> {
    return this.#sold(tenant, loaders, item);
  }

  @ResolveField(() => Int, {
    nullable: true,
    description:
      'Whole days what is available lasts at the pace it sold in the last 30: none when it is ' +
      'out; null when it sold none.',
  })
  async daysOfStockLeft(
    @CurrentTenant() tenant: TenantContext,
    @Loaders() loaders: RequestLoaders,
    @Parent() item: LowStockItem,
  ): Promise<number | null> {
    return daysLeft(item.available, await this.#sold(tenant, loaders, item));
  }

  @ResolveField(() => StockSeason, {
    nullable: true,
    description:
      'The season on or within 90 days (ADR-863), with how much faster than usual it sold in it ' +
      "last year, or the shop's stock did where it has no such history; null for none ahead.",
  })
  async season(
    @CurrentTenant() tenant: TenantContext,
    @Loaders() loaders: RequestLoaders,
    @Parent() item: LowStockItem,
  ): Promise<StockSeason | null> {
    const outlook = await loadSeason(
      loaders,
      this.lowStock,
      tenant,
      item.record.variantId,
      item.record.locationId,
    );
    return outlook && toStockSeason(outlook);
  }

  @ResolveField(() => Int, {
    description:
      'Units it is expected to sell in the coming `days` (INV-08, ADR-863): at its pace of the ' +
      "last 30, and on the days of a season ahead at that pace times the season's lift.",
  })
  async forecast(
    @CurrentTenant() tenant: TenantContext,
    @Loaders() loaders: RequestLoaders,
    @Parent() item: LowStockItem,
    @Args('days', { type: () => Int, nullable: true, description: '1 to 90; 30 unless given.' })
    days?: number | null,
  ): Promise<number> {
    const span = Math.min(Math.max(days ?? SALES_PACE_DAYS, 1), SEASON_LIMITS.aheadDays);
    const [sold, outlook] = await Promise.all([
      this.#sold(tenant, loaders, item),
      loadSeason(loaders, this.lowStock, tenant, item.record.variantId, item.record.locationId),
    ]);
    return forecastUnits(sold, span, pkDayOf(new Date()), outlook);
  }

  #paced(tenant: TenantContext, loaders: RequestLoaders, item: LowStockItem) {
    return Promise.all([
      this.#sold(tenant, loaders, item),
      loadSeason(loaders, this.lowStock, tenant, item.record.variantId, item.record.locationId),
    ]);
  }

  @ResolveField(() => [StockWeek], {
    description:
      'Its forecast week by week from today (INV-08, ADR-893): units expected to sell in each, ' +
      "as `forecast` reckons them, and what is left of what is available at each week's end.",
  })
  async weeks(
    @CurrentTenant() tenant: TenantContext,
    @Loaders() loaders: RequestLoaders,
    @Parent() item: LowStockItem,
    @Args('count', {
      type: () => Int,
      nullable: true,
      description: `1 to ${FORECAST_WEEKS.max}; ${FORECAST_WEEKS.default} unless given.`,
    })
    count?: number | null,
  ): Promise<StockWeek[]> {
    const weeks = Math.min(Math.max(count ?? FORECAST_WEEKS.default, 1), FORECAST_WEEKS.max);
    const [sold, outlook] = await this.#paced(tenant, loaders, item);
    return weeklyForecast(sold, item.available, pkDayOf(new Date()), outlook, weeks).map((week) =>
      Object.assign(new StockWeek(), week),
    );
  }

  @ResolveField(() => String, {
    nullable: true,
    description:
      'The day, YYYY-MM-DD, it is expected to sell the last of what is available (ADR-893), at ' +
      "its pace and a season's lift: today when none is; null when it sold none in the last 30 " +
      'days, or lasts past 90 more.',
  })
  async runsOutOn(
    @CurrentTenant() tenant: TenantContext,
    @Loaders() loaders: RequestLoaders,
    @Parent() item: LowStockItem,
  ): Promise<string | null> {
    const [sold, outlook] = await this.#paced(tenant, loaders, item);
    return runsOutOn(sold, item.available, pkDayOf(new Date()), outlook);
  }

  @ResolveField(() => InventoryItem, { description: 'How its stock is counted, and where it is.' })
  async inventoryItem(
    @CurrentTenant() tenant: TenantContext,
    @Loaders() loaders: RequestLoaders,
    @Parent() item: LowStockItem,
  ): Promise<InventoryItem> {
    return toInventoryItem(await loadItem(loaders, this.service, tenant, item.record.variantId));
  }
}

function toSettings(record: InventorySettingsRecord): InventorySettings {
  return Object.assign(new InventorySettings(), { lowStockThreshold: record.lowStockThreshold });
}

function toLowStockItem(record: LowStockRecord): LowStockItem {
  return Object.assign(new LowStockItem(), {
    variantId: toPublicId('variant', record.variantId),
    productId: toPublicId('product', record.productId),
    productTitle: record.productTitle,
    variantTitle: record.variantTitle,
    sku: record.sku,
    available: record.available,
    record,
  });
}

/** Where a page of the low-stock list ended, or a BAD_USER_INPUT error. */
function lowStockCursorAfter(after: string | null): LowStockCursor | null {
  if (!after) return null;
  const { available, id } = decodeCursor(after, ['available', 'id']);
  if (!/^-?\d{1,9}$/.test(available) || !isUuid(id)) throw badUserInput('Invalid cursor');
  return { available: Number(available), variantId: id };
}
