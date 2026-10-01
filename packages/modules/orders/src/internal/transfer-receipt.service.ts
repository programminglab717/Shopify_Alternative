import type { TenantContext } from '@hatti/api';
import { Database, type Tx } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import { newId } from '@hatti/ids';
import { ObjectStorage, extensionOf, sniffContentType } from '@hatti/storage';
import { Injectable } from '@nestjs/common';
import { and, asc, count, eq, inArray } from 'drizzle-orm';
import { OrderEvents, type OrderUpdatedPayload } from './events.js';
import type { LinkProblem } from './links.js';
import { addTimelineEntry } from './order-store.js';
import { awaitsTransfer, orderName } from './rules.js';
import { transferReceipts, type OrderRow } from './schema.js';

/** What a receipt may weigh, and how many an order takes. */
export const RECEIPT_LIMITS = { bytes: 10 * 1024 * 1024, perOrder: 5 } as const;

/** Photos, screenshots and PDFs: what banks' apps make of a transfer. */
export const RECEIPT_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] as const;
export type ReceiptTypeValue = (typeof RECEIPT_TYPES)[number];

/** How long a receipt's URL shows it: an hour. */
export const RECEIPT_URL_SECONDS = 3600;

/** A receipt of a bank transfer its customer sent through the order's page. */
export interface TransferReceiptRecord {
  id: string;
  orderId: string;
  contentType: ReceiptTypeValue;
  /** Bytes. */
  size: number;
  /** Where storage keeps it. */
  key: string;
  createdAt: Date;
}

/** A receipt as the order's page posts it: its bytes, or why there are none to take. */
export type ReceiptUpload = { data: Buffer } | 'too_large' | null;

/** A receipt's bytes in storage, waiting for its order to take them. */
export interface StoredReceipt {
  id: string;
  key: string;
  contentType: ReceiptTypeValue;
  size: number;
}

const isReceiptType = (type: string | null): type is ReceiptTypeValue =>
  (RECEIPT_TYPES as readonly (string | null)[]).includes(type);

/** How many receipts the order has, in the caller's transaction `tx`. */
export async function receiptCountIn(tx: Tx, shopId: string, orderId: string): Promise<number> {
  const [row] = await tx
    .select({ count: count() })
    .from(transferReceipts)
    .where(and(eq(transferReceipts.shopId, shopId), eq(transferReceipts.orderId, orderId)));
  return row?.count ?? 0;
}

/**
 * Receipts of bank transfers (PAY-02, ADR-080): a customer sends one through their order's page,
 * a photo, a screenshot or a PDF, until the order is paid; the shop sees them with the order,
 * through URLs signed for an hour, before marking it paid. Storage keeps them under the shop's
 * prefix, by order.
 */
@Injectable()
export class TransferReceiptService {
  constructor(
    private readonly db: Database,
    private readonly storage: ObjectStorage,
  ) {}

  /** The receipts of each of `orderIds`, oldest first, for the Admin API. */
  async receiptsOf(
    tenant: TenantContext,
    orderIds: readonly string[],
  ): Promise<Map<string, TransferReceiptRecord[]>> {
    const byOrder = new Map<string, TransferReceiptRecord[]>(orderIds.map((id) => [id, []]));
    if (orderIds.length === 0) return byOrder;
    const rows = await this.db.tenant(tenant.shopId, (tx) =>
      tx
        .select()
        .from(transferReceipts)
        .where(
          and(
            eq(transferReceipts.shopId, tenant.shopId),
            inArray(transferReceipts.orderId, [...orderIds]),
          ),
        )
        .orderBy(asc(transferReceipts.createdAt), asc(transferReceipts.id)),
    );
    for (const row of rows) {
      byOrder.get(row.orderId)?.push({
        id: row.id,
        orderId: row.orderId,
        contentType: row.contentType as ReceiptTypeValue,
        size: row.size,
        key: row.key,
        createdAt: row.createdAt,
      });
    }
    return byOrder;
  }

  /** A URL that shows the receipt for an hour, named for its order: "Receipt #1023-2.jpg". */
  urlOf(receipt: TransferReceiptRecord, orderNumber: number, position: number): string {
    const extension = extensionOf(receipt.contentType);
    return this.storage.signDownload(receipt.key, RECEIPT_URL_SECONDS, {
      filename: `Receipt ${orderName(orderNumber)}-${position}.${extension}`,
    });
  }

  /**
   * Keeps what the customer sent for `orderId` in storage, outside any transaction, if it is a
   * receipt at all: a photo or a PDF of at most 10 MiB. Returns why it is not, if not.
   */
  async store(
    shopId: string,
    orderId: string,
    upload: ReceiptUpload,
  ): Promise<StoredReceipt | LinkProblem> {
    if (upload === null || (upload !== 'too_large' && upload.data.length === 0)) {
      return { kind: 'receipt', reason: 'missing' };
    }
    if (upload === 'too_large' || upload.data.length > RECEIPT_LIMITS.bytes) {
      return { kind: 'receipt', reason: 'size' };
    }
    const type = sniffContentType(upload.data);
    if (!isReceiptType(type)) return { kind: 'receipt', reason: 'type' };
    const id = newId();
    const key = `shops/${shopId}/receipts/${orderId}/${id}.${extensionOf(type)}`;
    await this.storage.put(key, upload.data, type);
    return { id, key, contentType: type, size: upload.data.length };
  }

  /**
   * `order`, locked in the caller's transaction `tx`, takes a receipt {@link store} kept, as its
   * customer sent it through their link: while it waits for its transfer, and has fewer than five.
   * The timeline says so. Returns why it did not, if not, when the caller {@link discard}s it.
   */
  async receiveLocked(
    tx: Tx,
    shopId: string,
    order: OrderRow,
    stored: StoredReceipt | LinkProblem,
  ): Promise<LinkProblem | null> {
    if (order.status !== 'open' || !awaitsTransfer(order)) {
      return { kind: 'too_late', action: 'receipt' };
    }
    if ('kind' in stored) return stored;
    if ((await receiptCountIn(tx, shopId, order.id)) >= RECEIPT_LIMITS.perOrder) {
      return { kind: 'receipt', reason: 'count' };
    }
    await tx.insert(transferReceipts).values({
      shopId,
      id: stored.id,
      orderId: order.id,
      key: stored.key,
      contentType: stored.contentType,
      size: stored.size,
    });
    await addTimelineEntry(
      tx,
      shopId,
      order.id,
      'system',
      'receipt',
      'The customer sent a receipt for their transfer through their link',
    );
    await appendEvent<OrderUpdatedPayload>(tx, shopId, {
      type: OrderEvents.OrderUpdated,
      aggregateType: 'order',
      aggregateId: order.id,
      payload: { changed: ['transferReceipt'], stage: order.stage, version: order.version },
    });
    return null;
  }

  /** Removes a receipt {@link store} kept that its order did not take; a failure leaves it. */
  async discard(stored: StoredReceipt | LinkProblem): Promise<void> {
    if ('kind' in stored) return;
    await this.storage.delete(stored.key).catch(() => undefined);
  }
}
