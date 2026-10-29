import {
  CurrentTenant,
  Money,
  PlanAllowance,
  RequireScopes,
  UserError,
  badUserInput,
  deniedToRole,
  hasCapability,
  pageSize,
  type TenantContext,
} from '@hatti/api';
import { toPublicId } from '@hatti/ids';
import { money } from '@hatti/money';
import { Optional } from '@nestjs/common';
import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { SalesReportExportService } from '../sales-report-export.js';
import {
  SalesReportService,
  averageOrderValue,
  grossProfit,
  netSales,
  profit,
  returnOnAdSpend,
  totalSales,
  type SalesDimension as SalesDimensionValue,
  type SalesIntervalValue,
  type SalesTally,
} from '../sales-report.service.js';
import {
  ProductSales,
  Sales,
  SalesComparison,
  SalesPeriod,
  SalesReport,
  SalesReportArgs,
  SalesReportExportArgs,
  SalesReportExportPayload,
  SalesRow,
} from './sales-report.types.js';
import { OrderExportFile } from './export.types.js';

@Resolver()
export class SalesReportResolver {
  constructor(
    private readonly sales: SalesReportService,
    private readonly exports: SalesReportExportService,
    @Optional() private readonly allowance?: PlanAllowance,
  ) {}

  @Mutation(() => SalesReportExportPayload, {
    description:
      "The sales report as an Excel workbook for the shop's accountant (ANL-10, ADR-798): what " +
      'each day, week or month came to, a row each and their total last, the 250 products that ' +
      "sold most, and each channel's sales, amounts as salesReport gives them, true profit's " +
      'lines on the plans that have them. Staff need to be an owner, a manager or an ' +
      'accountant. Every export is recorded in the audit log.',
  })
  @RequireScopes('read_orders')
  async salesReportExport(
    @CurrentTenant() tenant: TenantContext,
    @Args() args: SalesReportExportArgs,
  ): Promise<SalesReportExportPayload> {
    if (tenant.actor.kind === 'staff' && !hasCapability(tenant.actor, 'export_orders')) {
      throw deniedToRole(
        'Access denied. Only owners, managers and accountants export the sales report.',
      );
    }
    const trueProfit = !(await this.allowance?.excludes(tenant.shopId, 'trueProfit'));
    const result = await this.exports.export(
      tenant,
      {
        placedFrom: args.placedFrom,
        placedBefore: args.placedBefore,
        interval: args.interval.toLowerCase() as SalesIntervalValue,
      },
      trueProfit,
    );
    return Object.assign(new SalesReportExportPayload(), {
      file: result.ok
        ? Object.assign(new OrderExportFile(), {
            filename: result.value.filename,
            contentType: result.value.contentType,
            content: result.value.content.toString('base64'),
          })
        : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Query(() => SalesReport, {
    description:
      "Sales analytics (ANL-02): what a period's orders came to, day by day, week by week or " +
      "month by month in the shop's time zone, the products that sold most, and by channel, " +
      'by where their last visits came from or their campaigns, or by customer or city ' +
      '(ADR-909). Worked out from the orders ' +
      'when asked. Its true profit lines are on Growth and bigger plans (ADR-529).',
  })
  @RequireScopes('read_orders')
  async salesReport(
    @CurrentTenant() tenant: TenantContext,
    @Args() args: SalesReportArgs,
  ): Promise<SalesReport> {
    const by = args.by ? (args.by.toLowerCase() as SalesDimensionValue) : null;
    const result = await this.sales.report(tenant, {
      placedFrom: args.placedFrom,
      placedBefore: args.placedBefore,
      interval: args.interval.toLowerCase() as SalesIntervalValue,
      topProducts: pageSize(args.topProducts, 10),
      by,
      first: pageSize(args.first),
    });
    if (!result.ok) throw badUserInput(result.errors[0]!.message);
    const report = result.value;
    const trueProfit = !(await this.allowance?.excludes(tenant.shopId, 'trueProfit'));
    const amount = (minor: bigint) => Money.from(money(minor, tenant.currency));
    const profitLine = (minor: bigint) => (trueProfit ? amount(minor) : null);
    const toSales = (tally: SalesTally) => {
      const net = netSales(tally);
      const average = averageOrderValue(tally);
      const gross = grossProfit(tally);
      return Object.assign(new Sales(), {
        orders: tally.orders,
        grossSales: amount(tally.grossSales),
        discounts: amount(tally.discounts),
        returns: amount(tally.returns),
        netSales: amount(net),
        shipping: amount(tally.shipping),
        additionalFees: amount(tally.additionalFees),
        totalSales: amount(totalSales(tally)),
        taxes: amount(tally.taxes),
        averageOrderValue: average === null ? null : amount(average),
        costOfGoods: amount(tally.costOfGoods),
        unitsWithoutCost: tally.unitsWithoutCost,
        grossProfit: amount(gross),
        // To four places, as COD health's rates are.
        grossMargin: net > 0n ? Math.round((Number(gross) / Number(net)) * 10_000) / 10_000 : null,
        shippingCosts: profitLine(tally.shippingCosts),
        shippingCostsEstimated: profitLine(tally.shippingCostsEstimated),
        writeOffs: profitLine(tally.writeOffs),
        claimsRecovered: profitLine(tally.claimsRecovered),
        profit: profitLine(profit(tally)),
        adSpend: tally.adSpend === null ? null : profitLine(tally.adSpend),
        returnOnAdSpend: trueProfit ? returnOnAdSpend(tally) : null,
        refunds: amount(tally.refunds),
      });
    };
    return Object.assign(new SalesReport(), {
      totals: toSales(report.totals),
      previous: Object.assign(new SalesComparison(), {
        placedFrom: report.previous.placedFrom,
        placedBefore: args.placedFrom,
        totals: toSales(report.previous.totals),
      }),
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
          costOfGoods: amount(product.costOfGoods),
        }),
      ),
      rows: report.rows.map((row) =>
        Object.assign(new SalesRow(), {
          key: by === 'source' && row.key !== null ? row.key.toUpperCase() : row.key,
          title: row.title,
          sales: toSales(row),
        }),
      ),
      trueProfit,
    });
  }
}
