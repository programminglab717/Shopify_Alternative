import {
  CurrentTenant,
  Money,
  RequireScopes,
  badUserInput,
  pageSize,
  type TenantContext,
} from '@hatti/api';
import { toPublicId } from '@hatti/ids';
import { money } from '@hatti/money';
import { Args, Query, Resolver } from '@nestjs/graphql';
import {
  SalesReportService,
  averageOrderValue,
  netSales,
  type SalesIntervalValue,
  type SalesTally,
} from '../sales-report.service.js';
import {
  ProductSales,
  Sales,
  SalesPeriod,
  SalesReport,
  SalesReportArgs,
} from './sales-report.types.js';

@Resolver()
export class SalesReportResolver {
  constructor(private readonly sales: SalesReportService) {}

  @Query(() => SalesReport, {
    description:
      "Sales analytics (ANL-02): what a period's orders came to, day by day, week by week or " +
      "month by month in the shop's time zone, and the products that sold most. Worked out " +
      'from the orders when asked.',
  })
  @RequireScopes('read_orders')
  async salesReport(
    @CurrentTenant() tenant: TenantContext,
    @Args() args: SalesReportArgs,
  ): Promise<SalesReport> {
    const result = await this.sales.report(tenant, {
      placedFrom: args.placedFrom,
      placedBefore: args.placedBefore,
      interval: args.interval.toLowerCase() as SalesIntervalValue,
      topProducts: pageSize(args.topProducts, 10),
    });
    if (!result.ok) throw badUserInput(result.errors[0]!.message);
    const report = result.value;
    const amount = (minor: bigint) => Money.from(money(minor, tenant.currency));
    const toSales = (tally: SalesTally) => {
      const net = netSales(tally);
      const average = averageOrderValue(tally);
      return Object.assign(new Sales(), {
        orders: tally.orders,
        grossSales: amount(tally.grossSales),
        discounts: amount(tally.discounts),
        returns: amount(tally.returns),
        netSales: amount(net),
        shipping: amount(tally.shipping),
        additionalFees: amount(tally.additionalFees),
        totalSales: amount(net + tally.shipping + tally.additionalFees),
        averageOrderValue: average === null ? null : amount(average),
      });
    };
    return Object.assign(new SalesReport(), {
      totals: toSales(report.totals),
      periods: report.periods.map((period) =>
        Object.assign(new SalesPeriod(), { start: period.start, sales: toSales(period) }),
      ),
      topProducts: report.topProducts.map((product) =>
        Object.assign(new ProductSales(), {
          productId: toPublicId('product', product.productId),
          title: product.title,
          unitsSold: product.unitsSold,
          orders: product.orders,
          grossSales: amount(product.grossSales),
        }),
      ),
    });
  }
}
