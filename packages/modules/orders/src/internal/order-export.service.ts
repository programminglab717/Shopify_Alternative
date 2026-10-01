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
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { OrderEvents, type OrderExportCreatedPayload } from './events.js';
import { orderConditions, type OrderFilter } from './order-filter.js';
import { loadOrders } from './order-store.js';
import type { OrderLineRecord, OrderRecord } from './records.js';
import { orderName } from './rules.js';

export const EXPORT_LIMITS = {
  orders: 10_000,
  /** Rows of an export with a row per line item. */
  lines: 50_000,
} as const;

/** A row per order, or a row per line item with its order's details beside it. */
export const EXPORT_LAYOUTS = ['orders', 'line_items'] as const;
export type ExportLayoutValue = (typeof EXPORT_LAYOUTS)[number];

export interface OrderExportInput extends Omit<OrderFilter, 'customerId'> {
  layout: ExportLayoutValue;
}

export interface OrderExportResult {
  csv: string;
  rowCount: number;
}

@Injectable()
export class OrderExportService {
  constructor(private readonly db: Database) {}

  /**
   * Orders as CSV, oldest first, filtered as the order list is: up to {@link EXPORT_LIMITS}
   * orders, one row each or one row per line item. Customers' numbers show as the caller sees
   * them, masked for most staff; every row carries a watermark naming who exported it and when.
   * Each export goes into the audit log and the outbox.
   */
  async export(
    tenant: TenantContext,
    input: OrderExportInput,
  ): Promise<MutationResult<OrderExportResult>> {
    if (input.placedFrom && input.placedBefore && input.placedFrom >= input.placedBefore) {
      return failOne(['placedBefore'], 'INVALID', 'Placed before must be later than placed from');
    }
    const conditions = orderConditions(input);
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
      if (orderCount > EXPORT_LIMITS.orders) {
        return failOne(
          ['query'],
          'TOO_MANY',
          `${orderCount.toLocaleString('en')} orders match; export at most ` +
            `${EXPORT_LIMITS.orders.toLocaleString('en')} at a time. Narrow it down, such as ` +
            'by the dates they were placed.',
        );
      }
      if (input.layout === 'line_items' && lineCount > EXPORT_LIMITS.lines) {
        return failOne(
          ['query'],
          'TOO_MANY',
          `The orders that match have ${lineCount.toLocaleString('en')} line items; export at ` +
            `most ${EXPORT_LIMITS.lines.toLocaleString('en')} at a time. Narrow it down, such ` +
            'as by the dates they were placed.',
        );
      }

      const shop = await shopProfile(tx, tenant.shopId);
      const orders = await loadOrders(tx, tenant.shopId, { where, order: sql`o.id` });
      // On every row, so that rows copied out of the file still say where they came from.
      const exporter =
        tenant.actor.kind === 'app'
          ? toPublicId('accessToken', tenant.actor.tokenId)
          : toPublicId('user', tenant.actor.userId);
      const watermark = `${exporter} ${new Date().toISOString()}`;
      const cells = new ExportCells(tenant, shop.timezone);
      const rows =
        input.layout === 'orders'
          ? [ORDER_COLUMNS, ...orders.map((order) => [...cells.order(order), watermark])]
          : [
              LINE_COLUMNS,
              ...orders.flatMap((order) =>
                order.lines.map((line) => [...cells.line(order, line), watermark]),
              ),
            ];
      const rowCount = rows.length - 1;

      const filter = {
        query: input.query?.trim() || null,
        stage: input.stage?.toUpperCase() ?? null,
        riskLevel: input.riskLevel?.toUpperCase() ?? null,
        placedFrom: input.placedFrom?.toISOString() ?? null,
        placedBefore: input.placedBefore?.toISOString() ?? null,
      };
      const layout = input.layout.toUpperCase();
      await appendEvent<OrderExportCreatedPayload>(tx, tenant.shopId, {
        type: OrderEvents.OrderExportCreated,
        aggregateType: 'order_export',
        aggregateId: newId(),
        payload: { rows: rowCount, layout, ...filter, ...actorColumnsOf(tenant.actor) },
      });
      // As the API has them: enum values, dates in ISO 8601.
      await recordAudit(tx, tenant.shopId, {
        action: 'orders.exported',
        subjectType: 'shop',
        subjectId: tenant.shopId,
        ...actorColumnsOf(tenant.actor),
        details: { rows: rowCount, layout, ...filter },
      });
      return { ok: true, value: { csv: toCsv(rows), rowCount } };
    });
  }
}

const ORDER_COLUMNS = [
  'Order',
  'Order ID',
  'Placed',
  'Stage',
  'Status',
  'Confirmation',
  'Financial status',
  'Fulfillment status',
  'Payment method',
  'Source',
  'Customer ID',
  'Name',
  'Phone',
  'Email',
  'Address',
  'Area',
  'Landmark',
  'City',
  'Province',
  'Postcode',
  'Items',
  'Units',
  'Subtotal',
  'Discount',
  'Transfer discount',
  'Shipping',
  'COD fee',
  'Taxes',
  'Total',
  'Amount paid',
  'Amount refunded',
  'COD amount',
  'Currency',
  'Risk score',
  'Risk level',
  'Tracking',
  'Tags',
  'Note',
  'Cancel reason',
  'Confirmed at',
  'Packed at',
  'Cancelled at',
  'Paid at',
  'Closed at',
  'Exported',
];

const LINE_COLUMNS = [
  'Order',
  'Order ID',
  'Placed',
  'Stage',
  'Financial status',
  'Customer ID',
  'Name',
  'Phone',
  'City',
  'Line',
  'Product',
  'Variant',
  'SKU',
  'Quantity',
  'Unit price',
  'Line total',
  'Line tax',
  'Shipped',
  'Product ID',
  'Variant ID',
  'Currency',
  'Exported',
];

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
      this.#at(order.createdAt),
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
      this.#at(order.confirmedAt),
      this.#at(order.packedAt),
      this.#at(order.cancelledAt),
      this.#at(order.paidAt),
      this.#at(order.closedAt),
    ];
  }

  line(order: OrderRecord, line: OrderLineRecord): (string | number | null)[] {
    return [
      orderName(order.number),
      toPublicId('order', order.id),
      this.#at(order.createdAt),
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
  #at(date: Date | null): string | null {
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
