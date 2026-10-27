import { actorColumnsOf, shopProfile, type MutationResult, type TenantContext } from '@hatti/api';
import { Database } from '@hatti/db';
import { recordAudit } from '@hatti/events';
import { money, toMajorString, type CurrencyCode } from '@hatti/money';
import {
  XLSX_CONTENT_TYPE,
  toXlsxWorkbook,
  type XlsxCell,
  type XlsxColumn,
  type XlsxSheet,
} from '@hatti/xlsx';
import { Injectable } from '@nestjs/common';
import {
  SALES_REPORT_LIMITS,
  SalesReportService,
  grossProfit,
  netSales,
  profit,
  totalSales,
  type SalesReportInput,
  type SalesIntervalValue,
  type SalesReport,
  type SalesTally,
} from './sales-report.service.js';

// The sales report as an Excel workbook for the shop's accountant (ANL-10, ADR-798): what each
// day, week or month came to in the report's own terms, with every period's total, the products
// that sold most and the sales of each channel, on sheets beside one another.

/** What the workbook is made of: the report, and how to say its amounts and periods. */
export interface SalesWorkbookInput {
  report: SalesReport;
  interval: SalesIntervalValue;
  currency: string;
  timezone: string;
  /** Whether the shop's plan includes true profit (ADR-529): its lines are left out where not. */
  trueProfit: boolean;
}

/** The amounts every row of sales has, in the order the report gives them. */
const SALES_COLUMNS: readonly XlsxColumn[] = [
  { header: 'Orders', type: 'number' },
  { header: 'Gross sales', type: 'amount' },
  { header: 'Discounts', type: 'amount' },
  { header: 'Returns', type: 'amount' },
  { header: 'Net sales', type: 'amount' },
  { header: 'Shipping', type: 'amount' },
  { header: 'Additional fees', type: 'amount' },
  { header: 'Taxes', type: 'amount' },
  { header: 'Total sales', type: 'amount' },
  { header: 'Refunds', type: 'amount' },
  { header: 'Cost of goods', type: 'amount' },
  { header: 'Gross profit', type: 'amount' },
];

/** The lines of true profit, on the plans that have it. */
const PROFIT_COLUMNS: readonly XlsxColumn[] = [
  { header: 'Shipping costs', type: 'amount' },
  { header: 'Write-offs', type: 'amount' },
  { header: 'Claims recovered', type: 'amount' },
  { header: 'Ad spend', type: 'amount' },
  { header: 'Profit', type: 'amount' },
];

/** "2026-10-01": the day a period starts on in the shop's time zone, or "2026-10" for a month. */
export function periodLabel(start: Date, interval: SalesIntervalValue, timezone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(start)
      .map((part) => [part.type, part.value]),
  );
  const day = `${parts.year}-${parts.month}-${parts.day}`;
  return interval === 'month' ? day.slice(0, 7) : day;
}

/**
 * The sales report as a workbook (ADR-798): a sheet of its periods, the first column the day each
 * starts on and the last row their total; the products that sold most; and each channel's sales.
 * Amounts in major units of the shop's currency, without the sales tax prices include but on
 * Taxes and Total sales, as the report has them (ADR-117).
 */
export function salesWorkbook(input: SalesWorkbookInput): Buffer {
  const { report, interval, currency, timezone, trueProfit } = input;
  const amount = (minor: bigint) => toMajorString(money(minor, currency as CurrencyCode));
  const columns = [...SALES_COLUMNS, ...(trueProfit ? PROFIT_COLUMNS : [])];
  const cells = (tally: SalesTally): XlsxCell[] => [
    tally.orders,
    amount(tally.grossSales),
    amount(tally.discounts),
    amount(tally.returns),
    amount(netSales(tally)),
    amount(tally.shipping),
    amount(tally.additionalFees),
    amount(tally.taxes),
    amount(totalSales(tally)),
    amount(tally.refunds),
    amount(tally.costOfGoods),
    amount(grossProfit(tally)),
    ...(trueProfit
      ? [
          amount(tally.shippingCosts),
          amount(tally.writeOffs),
          amount(tally.claimsRecovered),
          tally.adSpend === null ? null : amount(tally.adSpend),
          amount(profit(tally)),
        ]
      : []),
  ];
  const periodHeader = { day: 'Day', week: 'Week starting', month: 'Month' }[interval];
  const sheets: XlsxSheet[] = [
    {
      name: 'Sales',
      columns: [{ header: periodHeader }, ...columns],
      rows: [
        ...report.periods.map((period) => [
          periodLabel(period.start, interval, timezone),
          ...cells(period),
        ]),
        ['Total', ...cells(report.totals)],
      ],
    },
    {
      name: 'Products',
      columns: [
        { header: 'Product' },
        { header: 'Units sold', type: 'number' },
        { header: 'Orders', type: 'number' },
        { header: 'Gross sales', type: 'amount' },
        { header: 'Cost of goods', type: 'amount' },
      ],
      rows: report.topProducts.map((product) => [
        product.title,
        product.unitsSold,
        product.orders,
        amount(product.grossSales),
        amount(product.costOfGoods),
      ]),
    },
    {
      name: 'Channels',
      columns: [{ header: 'Channel' }, ...columns],
      rows: report.rows.map((row) => [row.title, ...cells(row)]),
    },
  ];
  return toXlsxWorkbook(sheets);
}

/** An export as a file to save. */
export interface SalesReportFile {
  /** "sales-2026-10-27.xlsx": the day it was exported, in the shop's time zone. */
  filename: string;
  contentType: string;
  content: Buffer;
}

@Injectable()
export class SalesReportExportService {
  constructor(
    private readonly db: Database,
    private readonly sales: SalesReportService,
  ) {}

  /**
   * The report as a workbook (ANL-10, ADR-798): its periods, the 250 products that sold most and
   * every channel's sales, true profit's lines only where `trueProfit` says the plan has them.
   * Each export is recorded in the audit log.
   */
  async export(
    tenant: TenantContext,
    input: Pick<SalesReportInput, 'placedFrom' | 'placedBefore' | 'interval'>,
    trueProfit: boolean,
    now: Date = new Date(),
  ): Promise<MutationResult<SalesReportFile>> {
    const result = await this.sales.report(tenant, {
      ...input,
      topProducts: SALES_REPORT_LIMITS.rows,
      by: 'source',
      first: SALES_REPORT_LIMITS.rows,
    });
    if (!result.ok) return result;
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { timezone } = await shopProfile(tx, tenant.shopId);
      const content = salesWorkbook({
        report: result.value,
        interval: input.interval,
        currency: tenant.currency,
        timezone,
        trueProfit,
      });
      await recordAudit(tx, tenant.shopId, {
        action: 'sales_report.exported',
        subjectType: 'shop',
        subjectId: tenant.shopId,
        ...actorColumnsOf(tenant.actor),
        details: {
          placedFrom: input.placedFrom.toISOString(),
          placedBefore: input.placedBefore.toISOString(),
          interval: input.interval.toUpperCase(),
        },
      });
      return {
        ok: true,
        value: {
          filename: `sales-${periodLabel(now, 'day', timezone)}.xlsx`,
          contentType: XLSX_CONTENT_TYPE,
          content,
        },
      };
    });
  }
}
