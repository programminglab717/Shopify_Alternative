import {
  actorColumnsOf,
  failOne,
  shopProfile,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import { Database } from '@hatti/db';
import { recordAudit } from '@hatti/events';
import { newId } from '@hatti/ids';
import { money, toMajorString, type CurrencyCode } from '@hatti/money';
import { XLSX_CONTENT_TYPE, toXlsxWorkbook, type XlsxCell, type XlsxColumn } from '@hatti/xlsx';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { periodLabel } from './sales-report-export.js';
import {
  SALES_REPORT_LIMITS,
  SalesReportService,
  averageOrderValue,
  grossProfit,
  netSales,
  profit,
  returnOnAdSpend,
  totalSales,
  type ProductSales,
  type SalesDimension,
  type SalesIntervalValue,
  type SalesTally,
} from './sales-report.service.js';

// Reports a shop saves of its own (ANL-06, ADR-817): the sales report broken down one way, with
// the columns chosen in the order chosen, over a period that moves with the day it is run. Only
// what to show is kept; what it shows is worked out from the orders when run, as the sales
// report's is (ADR-061).

export const CUSTOM_REPORT_LIMITS = {
  /** Reports a shop keeps. */
  perShop: 50,
  name: 80,
  columns: 20,
} as const;

/** What a report's rows are: days, weeks from Monday or months, products, or as the report's dimensions. */
export const REPORT_BREAKDOWNS = [
  'day',
  'week',
  'month',
  'product',
  'source',
  'visit_source',
  'campaign',
] as const;
export type ReportBreakdown = (typeof REPORT_BREAKDOWNS)[number];

/**
 * The period a report covers, as of the day it is run in the shop's time zone. "Last 7 days" and
 * the like are whole days before today; "this" week, month or year runs to the end of today.
 */
export const REPORT_PERIODS = [
  'today',
  'yesterday',
  'last_7_days',
  'last_30_days',
  'last_90_days',
  'this_week',
  'last_week',
  'this_month',
  'last_month',
  'last_12_months',
  'this_year',
] as const;
export type ReportPeriod = (typeof REPORT_PERIODS)[number];

export type ReportColumnKind = 'number' | 'amount' | 'ratio';

/** A value of a report's cell: a count, an amount in minor units, or a ratio; null for none. */
export type ReportValue = number | bigint | null;

interface ColumnDefinition<T> {
  title: string;
  kind: ReportColumnKind;
  /** A line of true profit, shown only on the plans that have it (ADR-529). */
  trueProfit?: true;
  value: (row: T) => ReportValue;
}

/** The columns of a report of sales by period, channel, visit source or campaign. */
export const SALES_REPORT_COLUMNS: Readonly<Record<string, ColumnDefinition<SalesTally>>> = {
  orders: { title: 'Orders', kind: 'number', value: (t) => t.orders },
  gross_sales: { title: 'Gross sales', kind: 'amount', value: (t) => t.grossSales },
  discounts: { title: 'Discounts', kind: 'amount', value: (t) => t.discounts },
  returns: { title: 'Returns', kind: 'amount', value: (t) => t.returns },
  net_sales: { title: 'Net sales', kind: 'amount', value: netSales },
  shipping: { title: 'Shipping', kind: 'amount', value: (t) => t.shipping },
  additional_fees: { title: 'Additional fees', kind: 'amount', value: (t) => t.additionalFees },
  taxes: { title: 'Taxes', kind: 'amount', value: (t) => t.taxes },
  total_sales: { title: 'Total sales', kind: 'amount', value: totalSales },
  refunds: { title: 'Refunds', kind: 'amount', value: (t) => t.refunds },
  average_order_value: { title: 'Average order value', kind: 'amount', value: averageOrderValue },
  cost_of_goods: { title: 'Cost of goods', kind: 'amount', value: (t) => t.costOfGoods },
  gross_profit: { title: 'Gross profit', kind: 'amount', value: grossProfit },
  gross_margin: {
    title: 'Gross margin',
    kind: 'ratio',
    value: (t) => {
      const net = netSales(t);
      return net > 0n ? Math.round((Number(grossProfit(t)) / Number(net)) * 10_000) / 10_000 : null;
    },
  },
  shipping_costs: {
    title: 'Shipping costs',
    kind: 'amount',
    trueProfit: true,
    value: (t) => t.shippingCosts,
  },
  write_offs: { title: 'Write-offs', kind: 'amount', trueProfit: true, value: (t) => t.writeOffs },
  claims_recovered: {
    title: 'Claims recovered',
    kind: 'amount',
    trueProfit: true,
    value: (t) => t.claimsRecovered,
  },
  ad_spend: { title: 'Ad spend', kind: 'amount', trueProfit: true, value: (t) => t.adSpend },
  profit: { title: 'Profit', kind: 'amount', trueProfit: true, value: profit },
  return_on_ad_spend: {
    title: 'Return on ad spend',
    kind: 'ratio',
    trueProfit: true,
    value: returnOnAdSpend,
  },
};

/** The columns of a report of products. */
export const PRODUCT_REPORT_COLUMNS: Readonly<Record<string, ColumnDefinition<ProductSales>>> = {
  units_sold: { title: 'Units sold', kind: 'number', value: (p) => p.unitsSold },
  orders: { title: 'Orders', kind: 'number', value: (p) => p.orders },
  gross_sales: { title: 'Gross sales', kind: 'amount', value: (p) => p.grossSales },
  cost_of_goods: { title: 'Cost of goods', kind: 'amount', value: (p) => p.costOfGoods },
  gross_profit: {
    title: 'Gross profit',
    kind: 'amount',
    value: (p) => p.grossSales - p.costOfGoods,
  },
};

/** The columns a breakdown takes. */
export function reportColumnsOf(
  breakdown: ReportBreakdown,
): Readonly<Record<string, ColumnDefinition<never>>> {
  return breakdown === 'product' ? PRODUCT_REPORT_COLUMNS : SALES_REPORT_COLUMNS;
}

export interface CustomReportInput {
  name: string;
  breakdown: ReportBreakdown;
  columns: readonly string[];
  period: ReportPeriod;
}

export interface CustomReportRecord extends CustomReportInput {
  id: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CustomReportColumn {
  key: string;
  title: string;
  kind: ReportColumnKind;
}

export interface CustomReportRow {
  /** The product's ID, the channel or the visit source as the report keys them; null by period. */
  key: string | null;
  /** "2026-10-01" for a day or a week from it, "2026-10" for a month; else the row's name. */
  label: string;
  values: ReportValue[];
}

/** What a report shows when run. */
export interface CustomReportResult {
  placedFrom: Date;
  placedBefore: Date;
  /** The columns shown: those of true profit are left out on the plans without it. */
  columns: CustomReportColumn[];
  rows: CustomReportRow[];
  /** The period's total, for a report of sales; none for one of products. */
  totals: ReportValue[] | null;
}

/** A report exported, and the name it was saved as. */
export interface CustomReportFile {
  /** "monthly-sales.xlsx". */
  filename: string;
  contentType: string;
  content: Buffer;
  name: string;
}

/** "2026-10-27" plus `days`. */
function addDays(day: string, days: number): string {
  const at = new Date(`${day}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

/** "2026-10-01" plus `months`. */
function addMonths(day: string, months: number): string {
  const at = new Date(`${day}T00:00:00Z`);
  at.setUTCMonth(at.getUTCMonth() + months);
  return at.toISOString().slice(0, 10);
}

/**
 * The days `period` covers as of `today` in the shop's time zone: from its first, to the day after
 * its last.
 */
export function reportPeriodDays(
  period: ReportPeriod,
  today: string,
): { fromDay: string; beforeDay: string } {
  const tomorrow = addDays(today, 1);
  // Monday of this week.
  const monday = addDays(today, -((new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7));
  const month = `${today.slice(0, 7)}-01`;
  switch (period) {
    case 'today':
      return { fromDay: today, beforeDay: tomorrow };
    case 'yesterday':
      return { fromDay: addDays(today, -1), beforeDay: today };
    case 'last_7_days':
      return { fromDay: addDays(today, -7), beforeDay: today };
    case 'last_30_days':
      return { fromDay: addDays(today, -30), beforeDay: today };
    case 'last_90_days':
      return { fromDay: addDays(today, -90), beforeDay: today };
    case 'this_week':
      return { fromDay: monday, beforeDay: tomorrow };
    case 'last_week':
      return { fromDay: addDays(monday, -7), beforeDay: monday };
    case 'this_month':
      return { fromDay: month, beforeDay: tomorrow };
    case 'last_month':
      return { fromDay: addMonths(month, -1), beforeDay: month };
    case 'last_12_months':
      return { fromDay: addMonths(month, -12), beforeDay: month };
    case 'this_year':
      return { fromDay: `${today.slice(0, 4)}-01-01`, beforeDay: tomorrow };
  }
}

type ReportRow = {
  id: string;
  name: string;
  breakdown: ReportBreakdown;
  columns: string[];
  period: ReportPeriod;
  created_at: string | Date;
  updated_at: string | Date;
};

const toRecord = (row: ReportRow): CustomReportRecord => ({
  id: row.id,
  name: row.name,
  breakdown: row.breakdown,
  columns: row.columns,
  period: row.period,
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
});

/** What is wrong with a report as given, if anything. */
function checked(input: CustomReportInput): MutationResult<CustomReportInput> {
  const name = input.name.trim();
  if (!name) return failOne(['input', 'name'], 'BLANK', 'Give the report a name');
  if (name.length > CUSTOM_REPORT_LIMITS.name) {
    return failOne(
      ['input', 'name'],
      'TOO_LONG',
      `A report's name is ${CUSTOM_REPORT_LIMITS.name} characters at most`,
    );
  }
  if (!REPORT_BREAKDOWNS.includes(input.breakdown)) {
    return failOne(['input', 'breakdown'], 'INVALID', 'Choose how the report breaks down');
  }
  if (!REPORT_PERIODS.includes(input.period)) {
    return failOne(['input', 'period'], 'INVALID', 'Choose the period the report covers');
  }
  const columns = [...new Set(input.columns)];
  if (columns.length === 0) {
    return failOne(['input', 'columns'], 'BLANK', 'Choose one column at least');
  }
  if (columns.length > CUSTOM_REPORT_LIMITS.columns) {
    return failOne(
      ['input', 'columns'],
      'TOO_MANY',
      `A report has ${CUSTOM_REPORT_LIMITS.columns} columns at most`,
    );
  }
  const known = reportColumnsOf(input.breakdown);
  const unknown = columns.findIndex((column) => !(column in known));
  if (unknown >= 0) {
    return failOne(
      ['input', 'columns', String(unknown)],
      'INVALID',
      input.breakdown === 'product'
        ? `A report of products has no column "${columns[unknown]}"`
        : `A report of sales has no column "${columns[unknown]}"`,
    );
  }
  return { ok: true, value: { ...input, name, columns } };
}

const INTERVALS: Partial<Record<ReportBreakdown, SalesIntervalValue>> = {
  day: 'day',
  week: 'week',
  month: 'month',
};

/**
 * Custom reports (ANL-06, ADR-817): saved, changed, deleted and listed by the shop, and run over
 * their period as of a day, or over a period given, as when a schedule sends one (ADR-818).
 */
@Injectable()
export class CustomReportService {
  constructor(
    private readonly db: Database,
    private readonly sales: SalesReportService,
  ) {}

  async list(tenant: TenantContext): Promise<CustomReportRecord[]> {
    const { shopId } = tenant;
    const { rows } = await this.db.tenant(shopId, (tx) =>
      tx.execute<ReportRow>(sql`
        SELECT id, name, breakdown, columns, period, created_at, updated_at
          FROM orders.custom_reports
         WHERE shop_id = ${shopId}
         ORDER BY lower(name), id`),
    );
    return rows.map(toRecord);
  }

  async get(tenant: TenantContext, id: string): Promise<CustomReportRecord | null> {
    const { shopId } = tenant;
    const { rows } = await this.db.tenant(shopId, (tx) =>
      tx.execute<ReportRow>(sql`
        SELECT id, name, breakdown, columns, period, created_at, updated_at
          FROM orders.custom_reports
         WHERE shop_id = ${shopId} AND id = ${id}`),
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async create(
    tenant: TenantContext,
    input: CustomReportInput,
  ): Promise<MutationResult<CustomReportRecord>> {
    const given = checked(input);
    if (!given.ok) return given;
    const { shopId } = tenant;
    return this.db.tenant(shopId, async (tx) => {
      // One at a time, so that two saved at once are counted.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('custom_reports:' || ${shopId}))`);
      const { rows: counted } = await tx.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM orders.custom_reports WHERE shop_id = ${shopId}`);
      if (counted[0]!.n >= CUSTOM_REPORT_LIMITS.perShop) {
        return failOne(
          ['input'],
          'TOO_MANY',
          `A shop keeps ${CUSTOM_REPORT_LIMITS.perShop} reports at most: delete one first`,
        );
      }
      const { name, breakdown, columns, period } = given.value;
      const { rows } = await tx.execute<ReportRow>(sql`
        INSERT INTO orders.custom_reports (shop_id, id, name, breakdown, columns, period)
        VALUES (${shopId}, ${newId()}, ${name}, ${breakdown}, ${sql.param(columns)}::text[],
                ${period})
        RETURNING id, name, breakdown, columns, period, created_at, updated_at`);
      const report = toRecord(rows[0]!);
      await recordAudit(tx, shopId, {
        action: 'custom_report.created',
        subjectType: 'customReport',
        subjectId: report.id,
        ...actorColumnsOf(tenant.actor),
        details: { name, breakdown, columns, period },
      });
      return { ok: true, value: report };
    });
  }

  async update(
    tenant: TenantContext,
    id: string,
    input: CustomReportInput,
  ): Promise<MutationResult<CustomReportRecord>> {
    const given = checked(input);
    if (!given.ok) return given;
    const { shopId } = tenant;
    const { name, breakdown, columns, period } = given.value;
    return this.db.tenant(shopId, async (tx) => {
      const { rows } = await tx.execute<ReportRow>(sql`
        UPDATE orders.custom_reports
           SET name = ${name}, breakdown = ${breakdown}, columns = ${sql.param(columns)}::text[],
               period = ${period}, updated_at = now()
         WHERE shop_id = ${shopId} AND id = ${id}
        RETURNING id, name, breakdown, columns, period, created_at, updated_at`);
      if (!rows[0]) return failOne(['id'], 'NOT_FOUND', 'Report not found');
      await recordAudit(tx, shopId, {
        action: 'custom_report.updated',
        subjectType: 'customReport',
        subjectId: id,
        ...actorColumnsOf(tenant.actor),
        details: { name, breakdown, columns, period },
      });
      return { ok: true, value: toRecord(rows[0]) };
    });
  }

  /** Whether there was such a report to delete. */
  async delete(tenant: TenantContext, id: string): Promise<boolean> {
    const { shopId } = tenant;
    return this.db.tenant(shopId, async (tx) => {
      const { rows } = await tx.execute<{ name: string }>(sql`
        DELETE FROM orders.custom_reports WHERE shop_id = ${shopId} AND id = ${id}
        RETURNING name`);
      if (!rows[0]) return false;
      await recordAudit(tx, shopId, {
        action: 'custom_report.deleted',
        subjectType: 'customReport',
        subjectId: id,
        ...actorColumnsOf(tenant.actor),
        details: { name: rows[0].name },
      });
      return true;
    });
  }

  /** When report `period` begins and ends as of `at`, in the shop's time zone. */
  async periodOf(
    shopId: string,
    period: ReportPeriod,
    at: Date,
  ): Promise<{ placedFrom: Date; placedBefore: Date }> {
    return this.db.tenant(shopId, async (tx) => {
      const { timezone } = await shopProfile(tx, shopId);
      const { rows: today } = await tx.execute<{ day: string }>(
        sql`SELECT (${at.toISOString()}::timestamptz AT TIME ZONE ${timezone})::date::text AS day`,
      );
      const { fromDay, beforeDay } = reportPeriodDays(period, today[0]!.day);
      const { rows } = await tx.execute<{ from: string | Date; before: string | Date }>(sql`
        SELECT ${fromDay}::date::timestamp AT TIME ZONE ${timezone} AS "from",
               ${beforeDay}::date::timestamp AT TIME ZONE ${timezone} AS "before"`);
      return { placedFrom: new Date(rows[0]!.from), placedBefore: new Date(rows[0]!.before) };
    });
  }

  /**
   * What `report` shows: over its own period as of `at`, or over `over` where given. The lines of
   * true profit are left out where `trueProfit` says the plan has none (ADR-529).
   */
  async run(
    tenant: TenantContext,
    report: Pick<CustomReportInput, 'breakdown' | 'columns' | 'period'>,
    trueProfit: boolean,
    at: Date,
    over?: { placedFrom: Date; placedBefore: Date },
  ): Promise<MutationResult<CustomReportResult>> {
    const { placedFrom, placedBefore } =
      over ?? (await this.periodOf(tenant.shopId, report.period, at));
    const { breakdown } = report;
    const interval = INTERVALS[breakdown];
    const result = await this.sales.report(tenant, {
      placedFrom,
      placedBefore,
      interval: interval ?? 'month',
      topProducts: breakdown === 'product' ? SALES_REPORT_LIMITS.rows : 0,
      by: interval || breakdown === 'product' ? null : (breakdown as SalesDimension),
      first: SALES_REPORT_LIMITS.rows,
    });
    if (!result.ok) return result;
    const sales = result.value;
    const known = reportColumnsOf(breakdown) as Readonly<
      Record<string, ColumnDefinition<SalesTally & ProductSales>>
    >;
    const shown = report.columns.filter(
      (key) => key in known && (trueProfit || !known[key]!.trueProfit),
    );
    const values = (row: SalesTally | ProductSales) =>
      shown.map((key) => known[key]!.value(row as SalesTally & ProductSales));
    let rows: CustomReportRow[];
    if (interval) {
      const { timezone } = await this.db.tenant(tenant.shopId, (tx) =>
        shopProfile(tx, tenant.shopId),
      );
      rows = sales.periods.map((period) => ({
        key: null,
        label: periodLabel(period.start, interval, timezone),
        values: values(period),
      }));
    } else if (breakdown === 'product') {
      rows = sales.topProducts.map((product) => ({
        key: product.productId,
        label: product.title,
        values: values(product),
      }));
    } else {
      rows = sales.rows.map((row) => ({ key: row.key, label: row.title, values: values(row) }));
    }
    return {
      ok: true,
      value: {
        placedFrom,
        placedBefore,
        columns: shown.map((key) => ({ key, title: known[key]!.title, kind: known[key]!.kind })),
        rows,
        totals: breakdown === 'product' ? null : values(sales.totals),
      },
    };
  }

  /**
   * Report `id` as an Excel workbook of one sheet (ADR-817): its rows, amounts in major units of
   * the shop's currency, and the period's total last for a report of sales. Each export is
   * recorded in the audit log.
   */
  async export(
    tenant: TenantContext,
    id: string,
    trueProfit: boolean,
    at: Date,
    over?: { placedFrom: Date; placedBefore: Date },
  ): Promise<MutationResult<CustomReportFile>> {
    const report = await this.get(tenant, id);
    if (!report) return failOne(['id'], 'NOT_FOUND', 'Report not found');
    const ran = await this.run(tenant, report, trueProfit, at, over);
    if (!ran.ok) return ran;
    const content = reportWorkbook(report, ran.value, tenant.currency);
    const { shopId } = tenant;
    await this.db.tenant(shopId, (tx) =>
      recordAudit(tx, shopId, {
        action: 'custom_report.exported',
        subjectType: 'customReport',
        subjectId: id,
        ...actorColumnsOf(tenant.actor),
        details: {
          placedFrom: ran.value.placedFrom.toISOString(),
          placedBefore: ran.value.placedBefore.toISOString(),
        },
      }),
    );
    return {
      ok: true,
      value: {
        filename: `${reportFilename(report.name)}.xlsx`,
        contentType: XLSX_CONTENT_TYPE,
        content,
        name: report.name,
      },
    };
  }
}

/** "monthly-sales-by-channel": a report's name as a file's, plain letters and digits. */
export function reportFilename(name: string): string {
  const plain = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return plain || 'report';
}

const BREAKDOWN_HEADERS: Record<ReportBreakdown, string> = {
  day: 'Day',
  week: 'Week starting',
  month: 'Month',
  product: 'Product',
  source: 'Channel',
  visit_source: 'Visit source',
  campaign: 'Campaign',
};

/** A report's rows as a workbook of one sheet named for it. */
export function reportWorkbook(
  report: Pick<CustomReportInput, 'name' | 'breakdown'>,
  result: CustomReportResult,
  currency: string,
): Buffer {
  const cell = (value: ReportValue, kind: ReportColumnKind): XlsxCell => {
    if (value === null) return null;
    if (kind === 'amount') return toMajorString(money(BigInt(value), currency as CurrencyCode));
    return Number(value);
  };
  const columns: XlsxColumn[] = [
    { header: BREAKDOWN_HEADERS[report.breakdown] },
    ...result.columns.map((column): XlsxColumn => ({
      header: column.title,
      type: column.kind === 'amount' ? 'amount' : 'number',
    })),
  ];
  const cells = (values: ReportValue[]) =>
    values.map((value, index) => cell(value, result.columns[index]!.kind));
  return toXlsxWorkbook([
    {
      // A sheet's name is 31 characters at most, without the characters Excel keeps.
      name: report.name.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Report',
      columns,
      rows: [
        ...result.rows.map((row) => [row.label, ...cells(row.values)]),
        ...(result.totals ? [['Total', ...cells(result.totals)]] : []),
      ],
    },
  ]);
}
