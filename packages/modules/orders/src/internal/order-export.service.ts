import {
  actorColumnsOf,
  failOne,
  phoneAccess,
  shopProfile,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import { DEFAULT_VARIANT_TITLE } from '@hatti/catalog/public';
import { toCsv } from '@hatti/csv';
import { Database } from '@hatti/db';
import { appendEvent, recordAudit } from '@hatti/events';
import { newId, toPublicId } from '@hatti/ids';
import { money, toMajorString, type CurrencyCode } from '@hatti/money';
import { PK_PROVINCES, maskPkMobile, parsePkMobile, type PkProvinceCode } from '@hatti/pk';
import {
  XLSX_CONTENT_TYPE,
  toXlsxWorkbook,
  type XlsxCell,
  type XlsxColumn,
  type XlsxSheet,
} from '@hatti/xlsx';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { OrderEvents, type OrderExportCreatedPayload } from './events.js';
import { mapUrlOf } from './location.js';
import { orderConditions, parseOrderSearch, type OrderFilter } from './order-filter.js';
import { staffMemberOf } from './order.service.js';
import { loadOrders } from './order-store.js';
import { shownToStaff } from './plan-orders.js';
import type { OrderLineRecord, OrderRecord } from './records.js';
import { orderName } from './rules.js';
import { ORDER_STAGES } from './schema.js';

export const EXPORT_LIMITS = {
  orders: 10_000,
  /** Rows of an export with a row per line item. */
  lines: 50_000,
} as const;

/** A row per order, or a row per line item with its order's details beside it. */
export const EXPORT_LAYOUTS = ['orders', 'line_items'] as const;
export type ExportLayoutValue = (typeof EXPORT_LAYOUTS)[number];

/**
 * CSV, or an Excel workbook (ADR-182), its amounts numbers and its times dates a spreadsheet
 * sorts, sums and filters.
 */
export const EXPORT_FORMATS = ['csv', 'xlsx'] as const;
export type ExportFormatValue = (typeof EXPORT_FORMATS)[number];

export interface OrderExportInput extends Omit<OrderFilter, 'customerId'> {
  layout: ExportLayoutValue;
  /** CSV unless said. */
  format?: ExportFormatValue;
  /** The schedule it is sent for (ADR-183), which the audit log names. */
  scheduleId?: string | null;
}

/** An export as a file to save. */
export interface OrderExportFile {
  /** "orders-2026-10-05.xlsx": the day it was exported, in the shop's time zone. */
  filename: string;
  contentType: string;
  content: Buffer;
}

export interface OrderExportResult {
  /** The CSV's text, for an export as CSV; null for a workbook. */
  csv: string | null;
  file: OrderExportFile;
  rowCount: number;
}

@Injectable()
export class OrderExportService {
  constructor(private readonly db: Database) {}

  /**
   * Orders as CSV or an Excel workbook, oldest first, filtered as the order list is: up to {@link
   * EXPORT_LIMITS} orders unless `limits` say otherwise, as for the whole store's export (ADR-415),
   * one row each or one row per line item. Customers' numbers show as the caller sees them, masked
   * for most staff; every row carries a watermark naming who exported it and when. Each export goes
   * into the audit log and the outbox.
   */
  async export(
    tenant: TenantContext,
    input: OrderExportInput,
    limits: { orders?: number; lines?: number } = {},
  ): Promise<MutationResult<OrderExportResult>> {
    const most = { ...EXPORT_LIMITS, ...limits };
    if (input.placedFrom && input.placedBefore && input.placedFrom >= input.placedBefore) {
      return failOne(['placedBefore'], 'INVALID', 'Placed before must be later than placed from');
    }
    const search = parseOrderSearch(input.query ?? '');
    if (!search.ok) return failOne(['query'], 'INVALID', search.error);
    const conditions = orderConditions({ ...input, me: staffMemberOf(tenant) });
    const where = conditions.length > 0 ? sql.join(conditions, sql` AND `) : sql`true`;

    return this.db.tenant(tenant.shopId, async (tx): Promise<MutationResult<OrderExportResult>> => {
      const { rows: counted } = await tx.execute<{ orders: number; lines: number }>(sql`
          SELECT count(*)::int AS orders,
                 coalesce(sum((SELECT count(*) FROM orders.lines l
                                WHERE l.shop_id = o.shop_id AND l.order_id = o.id)), 0)::int
                   AS lines
            FROM orders.orders o
           WHERE o.shop_id = ${tenant.shopId} AND ${where}`);
      const { orders: orderCount, lines: lineCount } = counted[0]!;
      if (orderCount > most.orders) {
        return failOne(
          ['query'],
          'TOO_MANY',
          `${orderCount.toLocaleString('en')} orders match; export at most ` +
            `${most.orders.toLocaleString('en')} at a time. Narrow it down, such as ` +
            'by the dates they were placed.',
        );
      }
      if (input.layout === 'line_items' && lineCount > most.lines) {
        return failOne(
          ['query'],
          'TOO_MANY',
          `The orders that match have ${lineCount.toLocaleString('en')} line items; export at ` +
            `most ${most.lines.toLocaleString('en')} at a time. Narrow it down, such ` +
            'as by the dates they were placed.',
        );
      }

      const shop = await shopProfile(tx, tenant.shopId);
      // Those past their plan's limit with their customers hidden, as on their pages (ADR-263).
      const orders = (await loadOrders(tx, tenant.shopId, { where, order: sql`o.id` })).map(
        shownToStaff,
      );
      // On every row, so that rows copied out of the file still say where they came from.
      const exporter =
        tenant.actor.kind === 'app'
          ? toPublicId('accessToken', tenant.actor.tokenId)
          : toPublicId('user', tenant.actor.userId);
      const now = new Date();
      const watermark = `${exporter} ${now.toISOString()}`;
      const cells = new ExportCells(tenant, shop.timezone);
      const columns = input.layout === 'orders' ? ORDER_COLUMNS : LINE_COLUMNS;
      const rows =
        input.layout === 'orders'
          ? orders.map((order) => [...cells.order(order), watermark])
          : orders.flatMap((order) =>
              order.lines.map((line) => [...cells.line(order, line), watermark]),
            );
      const rowCount = rows.length;
      const format = input.format ?? 'csv';
      const filename =
        `${input.layout === 'orders' ? 'orders' : 'order-items'}-` +
        `${cells.at(now)!.slice(0, 10)}.${format}`;
      const csv =
        format === 'csv' ? toCsv([columns.map((column) => column.header), ...rows]) : null;
      const file: OrderExportFile =
        csv === null
          ? {
              filename,
              contentType: XLSX_CONTENT_TYPE,
              // The rows, then their totals beside them (ADR-632).
              content: toXlsxWorkbook([
                { name: input.layout === 'orders' ? 'Orders' : 'Order items', columns, rows },
                ...(input.layout === 'orders'
                  ? orderTotals(orders, cells, tenant.currency)
                  : lineTotals(orders, tenant.currency)),
              ]),
            }
          : { filename, contentType: 'text/csv; charset=utf-8', content: Buffer.from(csv) };

      const filter = {
        query: input.query?.trim() || null,
        stage: input.stage?.toUpperCase() ?? null,
        riskLevel: input.riskLevel?.toUpperCase() ?? null,
        placedFrom: input.placedFrom?.toISOString() ?? null,
        placedBefore: input.placedBefore?.toISOString() ?? null,
      };
      const layout = input.layout.toUpperCase();
      const shape = {
        rows: rowCount,
        layout,
        format: format.toUpperCase(),
        ...(input.scheduleId ? { schedule: toPublicId('exportSchedule', input.scheduleId) } : {}),
      };
      await appendEvent<OrderExportCreatedPayload>(tx, tenant.shopId, {
        type: OrderEvents.OrderExportCreated,
        aggregateType: 'order_export',
        aggregateId: newId(),
        payload: { ...shape, ...filter, ...actorColumnsOf(tenant.actor) },
      });
      // As the API has them: enum values, dates in ISO 8601.
      await recordAudit(tx, tenant.shopId, {
        action: 'orders.exported',
        subjectType: 'shop',
        subjectId: tenant.shopId,
        ...actorColumnsOf(tenant.actor),
        details: { ...shape, ...filter },
      });
      return { ok: true, value: { csv, file, rowCount } };
    });
  }
}

/**
 * Each column's heading, and how a workbook keeps its cells: amounts and counts as numbers, times
 * as dates; numbers, postcodes and SKUs stay text, as they may begin with 0.
 */
const ORDER_COLUMNS: readonly XlsxColumn[] = [
  { header: 'Order' },
  { header: 'Order ID' },
  { header: 'Placed', type: 'time' },
  { header: 'Stage' },
  { header: 'Status' },
  { header: 'Confirmation' },
  { header: 'Financial status' },
  { header: 'Fulfillment status' },
  { header: 'Payment method' },
  { header: 'Source' },
  { header: 'Customer ID' },
  { header: 'Name' },
  { header: 'Phone' },
  { header: 'Email' },
  { header: 'Address' },
  { header: 'Area' },
  { header: 'Landmark' },
  // The pin, as a link to it on the map (ADR-259).
  { header: 'Location' },
  { header: 'City' },
  { header: 'Province' },
  { header: 'Postcode' },
  { header: 'Items' },
  { header: 'Units', type: 'number' },
  { header: 'Subtotal', type: 'amount' },
  { header: 'Discount', type: 'amount' },
  { header: 'Transfer discount', type: 'amount' },
  { header: 'Online discount', type: 'amount' },
  { header: 'Shipping', type: 'amount' },
  { header: 'COD fee', type: 'amount' },
  { header: 'Taxes', type: 'amount' },
  { header: 'Total', type: 'amount' },
  { header: 'Amount paid', type: 'amount' },
  { header: 'Amount refunded', type: 'amount' },
  { header: 'COD amount', type: 'amount' },
  { header: 'Currency' },
  { header: 'Risk score', type: 'number' },
  { header: 'Risk level' },
  { header: 'Tracking' },
  { header: 'Tags' },
  { header: 'Note' },
  { header: 'Cancel reason' },
  { header: 'Confirmed at', type: 'time' },
  { header: 'Packed at', type: 'time' },
  { header: 'Cancelled at', type: 'time' },
  { header: 'Paid at', type: 'time' },
  { header: 'Closed at', type: 'time' },
  { header: 'Exported' },
];

const LINE_COLUMNS: readonly XlsxColumn[] = [
  { header: 'Order' },
  { header: 'Order ID' },
  { header: 'Placed', type: 'time' },
  { header: 'Stage' },
  { header: 'Financial status' },
  { header: 'Customer ID' },
  { header: 'Name' },
  { header: 'Phone' },
  { header: 'City' },
  { header: 'Line', type: 'number' },
  { header: 'Product' },
  { header: 'Variant' },
  { header: 'SKU' },
  { header: 'Quantity', type: 'number' },
  { header: 'Unit price', type: 'amount' },
  { header: 'Line total', type: 'amount' },
  { header: 'Line tax', type: 'amount' },
  { header: 'Shipped', type: 'number' },
  { header: 'Product ID' },
  { header: 'Variant ID' },
  { header: 'Currency' },
  { header: 'Exported' },
];

/** What a sheet of totals adds up for each of its groups of orders. */
const SUMMED_COLUMNS: readonly XlsxColumn[] = [
  { header: 'Orders', type: 'number' },
  { header: 'Units', type: 'number' },
  { header: 'Total', type: 'amount' },
  { header: 'Amount paid', type: 'amount' },
  { header: 'Amount refunded', type: 'amount' },
  { header: 'COD amount', type: 'amount' },
];

/** A group's sums, in minor units but its counts. */
interface OrderSums {
  orders: number;
  units: number;
  total: bigint;
  paid: bigint;
  refunded: bigint;
  cod: bigint;
}

/**
 * The orders' totals beside them (ADR-632): by the day each was placed, in the shop's time, and
 * by stage, in the order of the stages, each ending with every order's. Amounts in the shop's
 * currency, as its orders are.
 */
function orderTotals(
  orders: readonly OrderRecord[],
  cells: ExportCells,
  currency: string,
): XlsxSheet[] {
  const amount = (value: bigint) => toMajorString(money(value, currency as CurrencyCode));
  const row = (label: string, sums: OrderSums): XlsxCell[] => [
    label,
    sums.orders,
    sums.units,
    amount(sums.total),
    amount(sums.paid),
    amount(sums.refunded),
    amount(sums.cod),
  ];
  const sum = (group: readonly OrderRecord[]): OrderSums =>
    group.reduce<OrderSums>(
      (sums, order) => ({
        orders: sums.orders + 1,
        units: sums.units + order.lines.reduce((units, line) => units + line.quantity, 0),
        total: sums.total + order.total,
        paid: sums.paid + order.amountPaid,
        refunded: sums.refunded + order.amountRefunded,
        cod: sums.cod + order.codAmount,
      }),
      { orders: 0, units: 0, total: 0n, paid: 0n, refunded: 0n, cod: 0n },
    );
  const grouped = (key: (order: OrderRecord) => string) => {
    const groups = new Map<string, OrderRecord[]>();
    for (const order of orders) groups.set(key(order), [...(groups.get(key(order)) ?? []), order]);
    return groups;
  };
  const days = grouped((order) => cells.at(order.createdAt)!.slice(0, 10));
  const stages = grouped((order) => order.stage);
  const all = row('All', sum(orders));
  return [
    {
      name: 'By day',
      columns: [{ header: 'Day' }, ...SUMMED_COLUMNS],
      rows: [...[...days.keys()].sort().map((day) => row(day, sum(days.get(day)!))), all],
    },
    {
      name: 'By stage',
      columns: [{ header: 'Stage' }, ...SUMMED_COLUMNS],
      rows: [
        ...ORDER_STAGES.filter((stage) => stages.has(stage)).map((stage) =>
          row(stage, sum(stages.get(stage)!)),
        ),
        all,
      ],
    },
  ];
}

/**
 * The line items' totals beside them (ADR-632): by variant, the most sold first, with how many
 * were bought and for how much, ending with every line's.
 */
function lineTotals(orders: readonly OrderRecord[], currency: string): XlsxSheet[] {
  const amount = (value: bigint) => toMajorString(money(value, currency as CurrencyCode));
  const variants = new Map<
    string,
    { line: OrderLineRecord; quantity: number; total: bigint; tax: bigint }
  >();
  for (const line of orders.flatMap((order) => order.lines)) {
    const kept = variants.get(line.variantId) ?? { line, quantity: 0, total: 0n, tax: 0n };
    variants.set(line.variantId, {
      line: kept.line,
      quantity: kept.quantity + line.quantity,
      total: kept.total + line.total,
      tax: kept.tax + line.tax,
    });
  }
  const sold = [...variants.values()].sort(
    (a, b) => b.quantity - a.quantity || a.line.title.localeCompare(b.line.title),
  );
  return [
    {
      name: 'By product',
      columns: [
        { header: 'Product' },
        { header: 'Variant' },
        { header: 'SKU' },
        { header: 'Quantity', type: 'number' },
        { header: 'Line total', type: 'amount' },
        { header: 'Line tax', type: 'amount' },
      ],
      rows: [
        ...sold.map(({ line, quantity, total, tax }) => [
          line.title,
          variantOf(line, '', ''),
          line.sku,
          quantity,
          amount(total),
          amount(tax),
        ]),
        [
          'All',
          null,
          null,
          sold.reduce((sum, each) => sum + each.quantity, 0),
          amount(sold.reduce((sum, each) => sum + each.total, 0n)),
          amount(sold.reduce((sum, each) => sum + each.tax, 0n)),
        ],
      ],
    },
  ];
}

/** An order's cells, as the caller may see them, with times in the shop's time zone. */
class ExportCells {
  readonly #wholeNumbers: boolean;
  readonly #time: Intl.DateTimeFormat;

  constructor(tenant: TenantContext, timeZone: string) {
    this.#wholeNumbers = phoneAccess(tenant) === 'full';
    this.#time = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
  }

  order(order: OrderRecord): (string | number | null)[] {
    const address = order.shippingAddress;
    const amount = (value: bigint) => this.#amount(order, value);
    return [
      orderName(order.number),
      toPublicId('order', order.id),
      this.at(order.createdAt),
      order.stage,
      order.status,
      order.confirmationStatus,
      order.financialStatus,
      order.fulfillmentStatus,
      order.paymentMethod,
      order.source,
      toPublicId('customer', order.customerId),
      address.name,
      this.#phone(order.phone),
      order.email,
      address.address1,
      address.address2,
      address.landmark,
      address.location ? mapUrlOf(address.location) : null,
      address.city,
      address.provinceCode ? PK_PROVINCES[address.provinceCode as PkProvinceCode].name : null,
      address.zip,
      order.lines
        .map((line) => `${line.quantity} × ${line.title}${variantOf(line, ' (', ')')}`)
        .join('; '),
      order.lines.reduce((sum, line) => sum + line.quantity, 0),
      amount(order.subtotal),
      amount(order.discount),
      amount(order.transferDiscount),
      amount(order.onlineDiscount),
      amount(order.shipping),
      amount(order.codFee),
      // Included in the total, as prices include it (ADR-096).
      amount(order.totalTax),
      amount(order.total),
      amount(order.amountPaid),
      amount(order.amountRefunded),
      amount(order.codAmount),
      order.currency,
      order.risk ? (order.risk.score / 100).toFixed(2) : null,
      order.risk?.level ?? null,
      order.fulfillments
        .map((parcel) => [parcel.trackingCompany, parcel.trackingNumber].filter(Boolean).join(' '))
        .filter(Boolean)
        .join('; '),
      order.tags.join(', '),
      order.note,
      order.cancelReason,
      this.at(order.confirmedAt),
      this.at(order.packedAt),
      this.at(order.cancelledAt),
      this.at(order.paidAt),
      this.at(order.closedAt),
    ];
  }

  line(order: OrderRecord, line: OrderLineRecord): (string | number | null)[] {
    return [
      orderName(order.number),
      toPublicId('order', order.id),
      this.at(order.createdAt),
      order.stage,
      order.financialStatus,
      toPublicId('customer', order.customerId),
      order.shippingAddress.name,
      this.#phone(order.phone),
      order.shippingAddress.city,
      line.position,
      line.title,
      variantOf(line, '', ''),
      line.sku,
      line.quantity,
      this.#amount(order, line.unitPrice),
      this.#amount(order, line.total),
      this.#amount(order, line.tax),
      line.fulfilledQuantity,
      toPublicId('product', line.productId),
      toPublicId('variant', line.variantId),
      order.currency,
    ];
  }

  /** "2026-09-29 01:30", which spreadsheets read as a date and time. */
  at(date: Date | null): string | null {
    if (!date) return null;
    const parts = Object.fromEntries(
      this.#time.formatToParts(date).map((part) => [part.type, part.value]),
    );
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
  }

  #amount(order: OrderRecord, value: bigint): string {
    return toMajorString(money(value, order.currency as CurrencyCode));
  }

  /** "0300 1234567" for callers who see numbers whole, "0300 ••••567" for the rest. */
  #phone(e164: string | null): string | null {
    if (!e164) return null;
    if (!this.#wholeNumbers) return maskPkMobile(e164);
    return parsePkMobile(e164)?.display ?? e164;
  }
}

/** The line's variant, between `before` and `after`; nothing for a product without options. */
function variantOf(line: OrderLineRecord, before: string, after: string): string {
  return line.variantTitle === DEFAULT_VARIANT_TITLE ? '' : `${before}${line.variantTitle}${after}`;
}
