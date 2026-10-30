import { failOne, shopProfile, type MutationResult, type TenantContext } from '@hatti/api';
import { ExpansionStoreService } from '@hatti/catalog/public';
import { Database } from '@hatti/db';
import { isCurrencyCode, type CurrencyCode } from '@hatti/money';
import {
  SalesReportService,
  StoreSalesSource,
  netSales,
  tallyOf,
  totalSales,
  type SalesIntervalValue,
  type StoreSales,
} from '@hatti/orders/public';
import { Injectable } from '@nestjs/common';
import { shopOwnerOf } from './expansion-copier.js';
import { convertBetween, rupeeRatesByDayIn } from './expansion-rates.js';

// What the owner's shops sold, on one page (ADR-932): this shop, then each expansion store they
// still own, each in its own currency and in this shop's, each day at that day's rate (ADR-974),
// a week or a month the sum of its days (ADR-975). Read for the stores' page and chart (ADR-955),
// and for a custom report of stores (ADR-985).

/** A period of one shop's sales. */
export interface ShopSalesPeriod {
  start: Date;
  orders: number;
  /** In the shop's own currency's minor units. */
  totalSales: bigint;
  /** In this shop's currency's; null where one of its days had no rate. */
  totalSalesHere: bigint | null;
}

/** What one of the owner's shops sold over the period. */
export interface ShopSales {
  shopId: string;
  name: string;
  /** This shop, rather than an expansion store of it. */
  here: boolean;
  currency: CurrencyCode;
  orders: number;
  netSales: bigint;
  totalSales: bigint;
  /** In this shop's currency's minor units; null where a day had no rate. */
  totalSalesHere: bigint | null;
  periods: ShopSalesPeriod[];
}

@Injectable()
export class ExpansionSales extends StoreSalesSource {
  readonly #sales: SalesReportService;

  constructor(
    private readonly db: Database,
    private readonly stores: ExpansionStoreService,
  ) {
    super();
    this.#sales = new SalesReportService(db);
  }

  /**
   * What this shop and each store `userId` still owns sold from `placedFrom` to `placedBefore`,
   * by `interval` in this shop's time; this shop first, then the stores, oldest first.
   */
  async of(
    tenant: TenantContext,
    userId: string,
    over: { placedFrom: Date; placedBefore: Date; interval: SalesIntervalValue },
  ): Promise<MutationResult<ShopSales[]>> {
    const linked = await this.stores.list(tenant);
    const shops = [tenant.shopId];
    for (const record of linked) {
      if ((await shopOwnerOf(this.db, record.targetShopId)) === userId) {
        shops.push(record.targetShopId);
      }
    }
    const { timezone } = await this.db.tenant(tenant.shopId, (tx) =>
      shopProfile(tx, tenant.shopId),
    );
    // Each day at its own rate, in this shop's time (ADR-974).
    const dayOf = (at: Date) =>
      new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(at);
    const { placedFrom, placedBefore, interval } = over;
    const rows: ShopSales[] = [];
    let ratesOn: ((day: string) => Map<string, bigint>) | null = null;
    for (const shopId of shops) {
      // Each store's days are this shop's, for one chart of them all.
      const periods = await this.#sales.periodsOf(
        shopId,
        { placedFrom, placedBefore, interval },
        timezone,
      );
      if (!periods.ok) return periods;
      // A week or a month is its days, each at its own rate (ADR-975): read by day as well.
      const days =
        interval === 'day'
          ? periods
          : await this.#sales.periodsOf(
              shopId,
              { placedFrom, placedBefore, interval: 'day' },
              timezone,
            );
      if (!days.ok) return days;
      const profile = await this.db.tenant(shopId, (tx) => shopProfile(tx, shopId));
      const currency = isCurrencyCode(profile.currency) ? profile.currency : 'PKR';
      // Every store's days are the same: their rates are read once.
      ratesOn ??= await this.db.tenant(tenant.shopId, (tx) =>
        rupeeRatesByDayIn(
          tx,
          days.value.map((each) => dayOf(each.start)),
        ),
      );
      const rates = ratesOn;
      const totals = tallyOf(periods.value);
      // Each day at its rate, then each period the sum of its days.
      const dayHeres = days.value.map((each) =>
        convertBetween(rates(dayOf(each.start)), totalSales(each), currency, tenant.currency),
      );
      const heres = periods.value.map((period, at) => {
        const until = periods.value[at + 1]?.start.getTime() ?? Infinity;
        let sum = 0n;
        for (const [index, each] of days.value.entries()) {
          const start = each.start.getTime();
          if (start < period.start.getTime() || start >= until) continue;
          const converted = dayHeres[index]!;
          if (converted === null) return null;
          sum += converted;
        }
        return sum;
      });
      rows.push({
        shopId,
        name: profile.name,
        here: shopId === tenant.shopId,
        currency,
        orders: totals.orders,
        netSales: netSales(totals),
        totalSales: totalSales(totals),
        // The whole period's is its periods', each at its own day's rate.
        totalSalesHere: heres.some((each) => each === null)
          ? null
          : heres.reduce<bigint>((sum, each) => sum + each!, 0n),
        periods: periods.value.map((period, at) => ({
          start: period.start,
          orders: period.orders,
          totalSales: totalSales(period),
          totalSalesHere: heres[at]!,
        })),
      });
    }
    return { ok: true, value: rows };
  }

  /** A custom report's stores (ADR-985), for the shop's owner alone, as the stores' page is. */
  async salesOf(
    tenant: TenantContext,
    placedFrom: Date,
    placedBefore: Date,
  ): Promise<MutationResult<StoreSales[]>> {
    const { actor } = tenant;
    if (actor.kind !== 'staff' || actor.role !== 'owner') {
      return failOne(
        ['breakdown'],
        'INVALID',
        "Only the shop's owner reads what its expansion stores sold",
      );
    }
    const read = await this.of(tenant, actor.userId, { placedFrom, placedBefore, interval: 'day' });
    if (!read.ok) return read;
    return {
      ok: true,
      value: read.value.map(({ shopId, name, here, orders, totalSalesHere }) => ({
        shopId,
        name,
        here,
        orders,
        totalSalesHere,
      })),
    };
  }
}
