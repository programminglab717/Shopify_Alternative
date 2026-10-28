import {
  AiGateway,
  readTransferReceipt,
  type AiResult,
  type TransferReceiptFile,
  type TransferReceiptReading,
} from '@hatti/ai';
import {
  AiCredits,
  aiCreditsMessage,
  failOne,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import { Database, type Tx } from '@hatti/db';
import { receiptImage } from '@hatti/images';
import { ObjectStorage } from '@hatti/storage';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { transferOwed } from './rules.js';
import type { BankAccountValue, PaymentMethodValue } from './schema.js';

// Receipts for transfers, read by the AI (PAY-08, ADR-845): staff ask for a receipt a customer
// sent (ADR-080) to be read, and see what it says beside what Hatti makes of it: whether its
// amount is what the order waited for then, whether it was sent to the account the customer was
// told, whether its reference is on another order's receipt, and whether it was sent before the
// order was placed. The AI sees the receipt alone, never the order. Staff confirm the payment
// themselves: a reading never marks an order paid. Each reading spends an AI credit, once.

/** How a receipt's amount compares with what its order waited for when it was read. */
export type ReceiptAmountCheck = 'matches' | 'short' | 'over' | 'unknown';

/** Whether a receipt was sent to the account its customer was told. */
export type ReceiptAccountCheck = 'matches' | 'differs' | 'unknown';

/** A receipt as the AI read it, with what Hatti makes of it. */
export type ReceiptReadingView =
  | { outcome: 'not_a_receipt' | 'failed'; readAt: Date }
  | {
      outcome: 'read';
      readAt: Date;
      amount: bigint | null;
      paidOn: string | null;
      reference: string | null;
      senderName: string | null;
      senderBank: string | null;
      recipientName: string | null;
      recipientAccount: string | null;
      /** What its order waited for by transfer when it was read. */
      owed: bigint;
      amountCheck: ReceiptAmountCheck;
      accountCheck: ReceiptAccountCheck;
      /** The numbers of the shop's other orders with a receipt of the same reference. */
      sameReferenceOrders: number[];
      /** Whether the day it says it was sent is before its order was placed, in Pakistan. */
      beforeOrder: boolean;
    };

type ReadingRow = {
  id: string;
  order_id: string;
  key: string;
  content_type: string;
  read_at: Date | string | null;
  read_outcome: 'read' | 'not_a_receipt' | 'failed' | null;
  read_amount: string | null;
  read_paid_on: string | null;
  read_reference: string | null;
  read_sender_name: string | null;
  read_sender_bank: string | null;
  read_recipient_name: string | null;
  read_recipient_account: string | null;
  read_owed: string | null;
  read_reference_key: string | null;
  order_day: string;
  bank_account: BankAccountValue | null;
  payment_method: PaymentMethodValue;
  amount_paid: string;
  total: string;
  advance_due: string;
};

/** A reference as compared: its letters and digits alone, upper case; null for too little. */
export function referenceKey(reference: string | null): string | null {
  const key = (reference ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return key.length >= 6 ? key : null;
}

/** The letters of a name, lower case, for telling whether two are the same. */
const lettersOf = (name: string): string => name.toLowerCase().replace(/[^a-z]/g, '');

/**
 * Whether `shown`, the account a receipt says the money went to, and `name`, whose it says it
 * is, are those of `account`, the one the customer was told: its digits as banking apps mask
 * them, the last four or more, ending its IBAN or its Raast ID's number; else the name, where it
 * is plainly the account's title or a cut of it. Names on receipts are cut and spelt as each bank
 * keeps them, so a name alone never says the account differs.
 */
export function accountCheck(
  shown: string | null,
  name: string | null,
  account: BankAccountValue | null,
): ReceiptAccountCheck {
  if (!account) return 'unknown';
  const tail = /(\d{4,})\D*$/.exec(shown ?? '')?.[1];
  if (tail) {
    const raast = account.raastId?.replace(/\D/g, '');
    const numbers = [
      account.iban.replace(/\D/g, ''),
      ...(raast ? [raast, `0${raast.slice(2)}`] : []),
    ];
    return numbers.some((number) => number.endsWith(tail)) ? 'matches' : 'differs';
  }
  const said = lettersOf(name ?? '');
  const title = lettersOf(account.title);
  if (said.length >= 4 && title.length >= 4 && (title.startsWith(said) || said.startsWith(title))) {
    return 'matches';
  }
  return 'unknown';
}

/** How `amount` compares with `owed`, what the order waited for. */
export function amountCheck(amount: bigint | null, owed: bigint): ReceiptAmountCheck {
  if (amount === null || owed === 0n) return 'unknown';
  return amount === owed ? 'matches' : amount < owed ? 'short' : 'over';
}

const date = (value: Date | string): Date => (value instanceof Date ? value : new Date(value));

@Injectable()
export class ReceiptReadingService {
  constructor(
    private readonly db: Database,
    private readonly storage: ObjectStorage,
    /** The AI gateway, where the host configured one (ADR-463): without it, no readings. */
    @Optional() @Inject(AiGateway) private readonly ai?: AiGateway | null,
    /** The AI credits of the shop's plan (ADR-533); without them, readings are not counted. */
    @Optional() @Inject(AiCredits) private readonly credits?: AiCredits | null,
  ) {}

  /** Whether receipts are read here at all: once the host set the AI up. */
  get available(): boolean {
    return Boolean(this.ai);
  }

  /** The readings of each of `receiptIds`, with what Hatti makes of them; none for unread ones. */
  async readingsOf(
    tenant: TenantContext,
    receiptIds: readonly string[],
  ): Promise<Map<string, ReceiptReadingView | null>> {
    const readings = new Map<string, ReceiptReadingView | null>(receiptIds.map((id) => [id, null]));
    if (receiptIds.length === 0) return readings;
    await this.db.tenant(tenant.shopId, async (tx) => {
      const rows = await rowsOf(tx, tenant.shopId, receiptIds);
      const keys = [...new Set(rows.map((row) => row.read_reference_key).filter(Boolean))];
      const same = new Map<string, { orderId: string; number: number }[]>();
      if (keys.length > 0) {
        const { rows: others } = await tx.execute<{
          key: string;
          order_id: string;
          number: number;
        }>(sql`
          SELECT DISTINCT r.read_reference_key AS key, r.order_id, o.number
            FROM orders.transfer_receipts r
            JOIN orders.orders o ON o.shop_id = r.shop_id AND o.id = r.order_id
           WHERE r.shop_id = ${tenant.shopId}
             AND r.read_reference_key = ANY(${sql.param(keys)}::text[])
           ORDER BY o.number`);
        for (const other of others) {
          same.set(other.key, [
            ...(same.get(other.key) ?? []),
            { orderId: other.order_id, number: other.number },
          ]);
        }
      }
      for (const row of rows) {
        readings.set(row.id, viewOf(row, same));
      }
    });
    return readings;
  }

  /**
   * Reads the receipt `receiptId` with the AI, as of `now`, and keeps what it says; or the
   * reading it has, which costs nothing again. Why it is not read, if not: the AI out of reach,
   * the shop's credits used up, or no such receipt.
   */
  async read(
    tenant: TenantContext,
    receiptId: string,
    now: Date = new Date(),
  ): Promise<MutationResult<ReceiptReadingView>> {
    const ai = this.ai;
    if (!ai) return failOne(['base'], 'UNAVAILABLE', "Reading receipts with AI isn't set up here");
    const [row] = await this.db.tenant(tenant.shopId, (tx) =>
      rowsOf(tx, tenant.shopId, [receiptId]),
    );
    if (!row) return failOne(['id'], 'NOT_FOUND', 'No such receipt');
    if (row.read_outcome === 'read' || row.read_outcome === 'not_a_receipt') {
      return { ok: true, value: (await this.readingsOf(tenant, [receiptId])).get(receiptId)! };
    }
    const balance = await this.credits?.balanceOf(tenant.shopId, now);
    if (balance && balance.left <= 0) {
      return failOne(['base'], 'TOO_MANY', aiCreditsMessage(balance));
    }
    const file = await this.fileOf(row);
    const result: AiResult<TransferReceiptReading> = file
      ? await readTransferReceipt(ai, file)
      : { ok: false, reason: 'invalid', detail: 'Not a picture or PDF it opens' };
    const reading: TransferReceiptReading | null = result.ok ? result.value : null;
    const read = reading?.receipt ? reading : null;
    const usage = result.usage ?? { inputTokens: 0, outputTokens: 0 };
    const owed = transferOwed({
      paymentMethod: row.payment_method,
      amountPaid: BigInt(row.amount_paid),
      total: BigInt(row.total),
      advanceDue: BigInt(row.advance_due),
    });
    await this.db.tenant(tenant.shopId, (tx) =>
      tx.execute(sql`
        UPDATE orders.transfer_receipts
           SET read_at = ${now.toISOString()},
               read_outcome = ${reading ? (read ? 'read' : 'not_a_receipt') : 'failed'},
               read_amount = ${read?.amountMinor?.toString() ?? null},
               read_paid_on = ${read?.paidOn ?? null},
               read_reference = ${read?.reference ?? null},
               read_sender_name = ${read?.senderName ?? null},
               read_sender_bank = ${read?.senderBank ?? null},
               read_recipient_name = ${read?.recipientName ?? null},
               read_recipient_account = ${read?.recipientAccount ?? null},
               read_owed = ${read ? owed.toString() : null},
               read_reference_key = ${referenceKey(read?.reference ?? null)},
               read_input_tokens = read_input_tokens + ${usage.inputTokens},
               read_output_tokens = read_output_tokens + ${usage.outputTokens}
         WHERE shop_id = ${tenant.shopId} AND id = ${receiptId}`),
    );
    if (!reading) {
      return failOne(
        ['base'],
        'UNAVAILABLE',
        file
          ? 'The AI could not read this receipt just now: try again in a minute'
          : "This receipt's file doesn't open as a picture or a PDF",
      );
    }
    await this.credits?.spend(tenant.shopId, 'transfer_receipt', now);
    return { ok: true, value: (await this.readingsOf(tenant, [receiptId])).get(receiptId)! };
  }

  /** The receipt's file as the AI is given it; null where storage lost it or it doesn't open. */
  private async fileOf(row: ReadingRow): Promise<TransferReceiptFile | null> {
    const stored = await this.storage.read(row.key);
    if (!stored) return null;
    if (row.content_type === 'application/pdf') {
      return { mediaType: 'application/pdf', data: stored.body };
    }
    try {
      return { mediaType: 'image/jpeg', data: await receiptImage(stored.body) };
    } catch {
      return null;
    }
  }
}

/** The receipts `ids` of the shop, with their readings and what their orders say. */
async function rowsOf(tx: Tx, shopId: string, ids: readonly string[]): Promise<ReadingRow[]> {
  const { rows } = await tx.execute<ReadingRow>(sql`
    SELECT r.id, r.order_id, r.key, r.content_type, r.read_at, r.read_outcome,
           r.read_amount::text AS read_amount, r.read_paid_on::text AS read_paid_on,
           r.read_reference, r.read_sender_name, r.read_sender_bank, r.read_recipient_name,
           r.read_recipient_account, r.read_owed::text AS read_owed, r.read_reference_key,
           (o.created_at AT TIME ZONE 'Asia/Karachi')::date::text AS order_day,
           o.bank_account, o.payment_method, o.amount_paid::text AS amount_paid,
           o.total::text AS total, o.advance_due::text AS advance_due
      FROM orders.transfer_receipts r
      JOIN orders.orders o ON o.shop_id = r.shop_id AND o.id = r.order_id
     WHERE r.shop_id = ${shopId} AND r.id = ANY(${sql.param([...ids])}::uuid[])`);
  return rows;
}

function viewOf(
  row: ReadingRow,
  same: Map<string, { orderId: string; number: number }[]>,
): ReceiptReadingView | null {
  if (!row.read_outcome || !row.read_at) return null;
  const readAt = date(row.read_at);
  if (row.read_outcome !== 'read') return { outcome: row.read_outcome, readAt };
  const amount = row.read_amount === null ? null : BigInt(row.read_amount);
  const owed = BigInt(row.read_owed ?? '0');
  return {
    outcome: 'read',
    readAt,
    amount,
    paidOn: row.read_paid_on,
    reference: row.read_reference,
    senderName: row.read_sender_name,
    senderBank: row.read_sender_bank,
    recipientName: row.read_recipient_name,
    recipientAccount: row.read_recipient_account,
    owed,
    amountCheck: amountCheck(amount, owed),
    accountCheck: accountCheck(
      row.read_recipient_account,
      row.read_recipient_name,
      row.bank_account,
    ),
    sameReferenceOrders: (row.read_reference_key ? (same.get(row.read_reference_key) ?? []) : [])
      .filter((other) => other.orderId !== row.order_id)
      .map((other) => other.number),
    beforeOrder: row.read_paid_on !== null && row.read_paid_on < row.order_day,
  };
}
