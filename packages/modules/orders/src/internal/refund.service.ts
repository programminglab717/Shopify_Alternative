import {
  InputChecker,
  UserErrorsRollback,
  actorColumnsOf,
  failOne,
  rollbackResult,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import { StoreCreditService } from '@hatti/customers/public';
import { Database, type Tx } from '@hatti/db';
import { appendEvent, recordAudit } from '@hatti/events';
import { takeStagedUploadIn } from '@hatti/files/public';
import { newId, toPublicId } from '@hatti/ids';
import { formatMoney, money, toMajorString, type CurrencyCode } from '@hatti/money';
import { Injectable, Optional } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { OrderEvents, type OrderRefundedPayload } from './events.js';
import { OnlinePayments } from './online-payments.js';
import { addTimelineEntry, loadOrder, lockOrder, updateOrder } from './order-store.js';
import { refundTaxOf } from './order-tax.js';
import type { OrderRecord, RefundRecord } from './records.js';
import { LIMITS } from './rules.js';
import { refunds, type OrderRow, type RefundMethodValue } from './schema.js';
import { TransferReceiptService, type StoredReceipt } from './transfer-receipt.service.js';

export interface RefundInput {
  /** In major units, like "2,000" or "499.50". */
  amount: string;
  method: RefundMethodValue;
  /** The transfer's reference, such as a wallet transaction ID; the gateway's, for `online`. */
  reference?: string | null;
  /** Why, for the shop's records. */
  note?: string | null;
  /** A refund as store credit's: when the credit expires; never, unless given (ADR-184). */
  storeCreditExpiresAt?: Date | null;
  /**
   * A refund staff sent by hand's receipt, a photo or a PDF, by the resource URL of the upload
   * `stagedUploadsCreate` staged for it (ADR-242).
   */
  receipt?: string | null;
}

export interface RefundResult {
  order: OrderRecord;
  refund: RefundRecord;
}

const METHOD_TEXT: Readonly<Record<RefundMethodValue, string>> = {
  bank_transfer: ' by bank transfer',
  mobile_wallet: ' to a mobile wallet',
  cash: ' in cash',
  other: '',
  exchange: ' to an exchange',
  online: ' online',
  store_credit: ' as store credit',
};

/** Money staff send themselves, whose refunds may keep a receipt (ADR-242). */
const BY_HAND: readonly RefundMethodValue[] = ['bank_transfer', 'mobile_wallet', 'cash', 'other'];

@Injectable()
export class RefundService {
  constructor(
    private readonly db: Database,
    /** Gives back what was paid online through the gateway (ADR-153); without it, nothing does. */
    @Optional() private readonly payments?: OnlinePayments,
    /** Gives refunds as store credit (ADR-184); without it, none is. */
    @Optional() private readonly storeCredit?: StoreCreditService,
    /** Keeps refunds' receipts among their orders' (ADR-242); without it, none are kept. */
    @Optional() private readonly receipts?: TransferReceiptService,
  ) {}

  /**
   * Records money given back on an order, up to what was paid on it and not refunded yet. Staff
   * send the money, then record it here; but `online`, which Hatti asks the payment gateway the
   * customer paid through to send, and records once the gateway says it is sent (ADR-153), and
   * `store_credit`, which credits the customer's store credit account with it instead, in the
   * same transaction, the credit's ID its reference (ADR-184). A refund staff sent may keep its
   * receipt, a staged upload copied among the order's receipts (ADR-242). The
   * order's financial status becomes refunded, or partially refunded, and its stage stays as it
   * is: a completed order stays completed. The timeline, the outbox and the audit log each get an
   * entry.
   */
  async refund(
    tenant: TenantContext,
    orderId: string,
    input: RefundInput,
    at: Date = new Date(),
  ): Promise<MutationResult<RefundResult>> {
    const check = new InputChecker();
    const amount = check.price(['input', 'amount'], input.amount, tenant.currency, {
      required: true,
    });
    if (amount === 0n)
      check.addMessage(['input', 'amount'], 'INVALID', 'A refund must be more than 0');
    const reference = check.text(['input', 'reference'], input.reference, {
      max: LIMITS.reference,
    });
    const note = check.text(['input', 'note'], input.note, { max: LIMITS.note }) ?? '';
    if (input.method === 'exchange') {
      check.addMessage(
        ['input', 'method'],
        'INVALID',
        'A refund by exchange is made by a return that sends one (returnCreate)',
      );
    }
    if (input.method === 'online' && reference !== null) {
      check.addMessage(
        ['input', 'reference'],
        'INVALID',
        "A refund online takes the gateway's reference for it: leave it out",
      );
    }
    const asCredit = input.method === 'store_credit';
    if (asCredit && reference !== null) {
      check.addMessage(
        ['input', 'reference'],
        'INVALID',
        "A refund as store credit takes its credit's ID for its reference: leave it out",
      );
    }
    const expiresAt = input.storeCreditExpiresAt ?? null;
    if (expiresAt && !asCredit) {
      check.addMessage(
        ['input', 'storeCreditExpiresAt'],
        'INVALID',
        'Only a refund as store credit expires',
      );
    } else if (expiresAt && expiresAt.getTime() <= at.getTime()) {
      check.addMessage(
        ['input', 'storeCreditExpiresAt'],
        'INVALID',
        'It must expire in the future',
      );
    }
    const receipt = input.receipt?.trim() || null;
    if (receipt !== null && !BY_HAND.includes(input.method)) {
      check.addMessage(
        ['input', 'receipt'],
        'INVALID',
        'A receipt is kept of money staff sent: not online, as store credit or by exchange',
      );
    } else if (receipt !== null && !this.receipts) {
      check.addMessage(['input', 'receipt'], 'INVALID', "Refunds' receipts are not kept here");
    }
    if (!check.ok || amount === null) return { ok: false, errors: check.errors };
    if (input.method === 'online') return this.#refundOnline(tenant, orderId, amount, note);
    const storeCredit = this.storeCredit;
    if (asCredit && !storeCredit) {
      return failOne(['input', 'method'], 'INVALID', 'Refunds as store credit are not given here');
    }
    // Storage is written outside the transaction, which holds nothing while it answers.
    const kept = receipt && (await this.receipts!.storeUpload(tenant.shopId, orderId, receipt));
    if (kept && 'code' in kept) return failOne(['input', 'receipt'], kept.code, kept.message);
    let result: MutationResult<RefundResult>;
    try {
      result = await this.#refundByHand(tenant, orderId, input, {
        amount,
        reference,
        note,
        expiresAt,
        at,
        receipt: kept || null,
      });
    } catch (error) {
      if (kept) await this.receipts!.discard(kept.stored);
      throw error;
    }
    if (kept && result.ok) await this.receipts!.removeUpload(kept.upload.key);
    else if (kept) await this.receipts!.discard(kept.stored);
    return result;
  }

  /** Records a refund staff gave, as {@link refund} says, its receipt kept if it has one. */
  async #refundByHand(
    tenant: TenantContext,
    orderId: string,
    input: RefundInput,
    checked: {
      amount: bigint;
      reference: string | null;
      note: string;
      expiresAt: Date | null;
      at: Date;
      receipt: { stored: StoredReceipt; upload: { key: string; size: number } } | null;
    },
  ): Promise<MutationResult<RefundResult>> {
    const { amount, reference, note, expiresAt, at, receipt } = checked;
    const asCredit = input.method === 'store_credit';
    const storeCredit = this.storeCredit;
    return rollbackResult(() =>
      this.db.tenant(tenant.shopId, async (tx): Promise<MutationResult<RefundResult>> => {
        const order = await lockOrder(tx, tenant.shopId, orderId);
        if (!order) return failOne(['id'], 'NOT_FOUND', 'Order not found');
        const format = (value: bigint) => formatMoney(money(value, order.currency as CurrencyCode));
        const refundable = order.amountPaid - order.amountRefunded;
        if (refundable === 0n) {
          return failOne(['id'], 'INVALID', 'Nothing paid on this order is left to refund');
        }
        if (amount > refundable) {
          return failOne(
            ['input', 'amount'],
            'INVALID',
            `A refund can be at most ${format(refundable)}: what was paid and not refunded yet`,
          );
        }
        if (asCredit && order.customerErasedAt) {
          return failOne(
            ['input', 'method'],
            'INVALID',
            "This order's customer was erased: give the refund another way",
          );
        }

        // Its receipt's upload is the order's now, no longer one the shop may make a file of.
        if (
          receipt &&
          !(await takeStagedUploadIn(tx, tenant.shopId, receipt.upload.key, receipt.upload.size))
        ) {
          return failOne(
            ['input', 'receipt'],
            'NOT_FOUND',
            'Give the resourceUrl of an upload stagedUploadsCreate staged',
          );
        }
        // Store credit's transaction is named first, for the refund's reference.
        const creditId = asCredit ? newId() : null;
        const { refundId } = await writeRefund(tx, tenant, order, {
          amount,
          method: input.method,
          reference: creditId ? toPublicId('storeCreditTransaction', creditId) : reference,
          note,
          receipt: receipt?.stored ?? null,
          message:
            `Refunded ${format(amount)}${METHOD_TEXT[input.method]}` +
            (receipt ? ', with its receipt' : ''),
        });
        if (creditId) {
          const credited = await storeCredit!.creditIn(
            tx,
            tenant,
            {
              id: creditId,
              customerId: order.customerId,
              currency: order.currency as CurrencyCode,
              amount,
              event: 'order_refund',
              expiresAt,
              orderId,
              refundId,
              note,
            },
            ['input', 'amount'],
            at,
          );
          if (!credited.ok) throw new UserErrorsRollback(credited.errors);
        }
        const record = (await loadOrder(tx, tenant.shopId, orderId))!;
        const refund = record.refunds.find((entry) => entry.id === refundId)!;
        return { ok: true, value: { order: record, refund } };
      }),
    );
  }

  /** Gives `amount` back through the gateway the customer paid with, which records it. */
  async #refundOnline(
    tenant: TenantContext,
    orderId: string,
    amount: bigint,
    note: string,
  ): Promise<MutationResult<RefundResult>> {
    if (!this.payments) {
      return failOne(['input', 'method'], 'INVALID', 'The shop takes no payments online');
    }
    const result = await this.payments.refund(tenant, orderId, { amount, note });
    if (!result.ok) return result;
    const { refundId } = result.value;
    const record = await this.db.tenant(tenant.shopId, (tx) =>
      loadOrder(tx, tenant.shopId, orderId),
    );
    const refund = refundId && record?.refunds.find((entry) => entry.id === refundId);
    if (!record || !refund) {
      // The gateway gave it back, but the order had nothing left to refund by then.
      return failOne(
        ['id'],
        'INVALID',
        'It went back through the gateway, but the order had nothing left to refund: its ' +
          'timeline says so',
      );
    }
    return { ok: true, value: { order: record, refund } };
  }
}

/**
 * Records `amount` given back online through `gateway` on the order, in the caller's
 * transaction, the order locked, as a refund of its own by `online` (ADR-153): the gateway said it
 * sent it. At most what was paid on the order and not refunded yet; anything beyond, as when a
 * refund recorded meanwhile took the rest, goes on its timeline. The refund's ID, or null if
 * nothing of it could be recorded; null too for an order gone.
 */
export async function refundOnlinePaymentIn(
  tx: Tx,
  tenant: TenantContext,
  refund: {
    orderId: string;
    amount: bigint;
    gateway: string;
    reference: string | null;
    note: string;
  },
): Promise<{ refundId: string | null } | null> {
  const order = await lockOrder(tx, tenant.shopId, refund.orderId);
  if (!order) return null;
  const format = (value: bigint) => formatMoney(money(value, order.currency as CurrencyCode));
  const via = `online through ${refund.gateway}${refund.reference ? `, reference ${refund.reference}` : ''}`;
  const refundable = order.amountPaid - order.amountRefunded;
  const recorded = refund.amount < refundable ? refund.amount : refundable;
  let refundId: string | null = null;
  if (recorded > 0n) {
    ({ refundId } = await writeRefund(tx, tenant, order, {
      amount: recorded,
      method: 'online',
      reference: refund.reference?.slice(0, LIMITS.reference) ?? null,
      note: refund.note,
      message: `Refunded ${format(recorded)} ${via}`,
    }));
  }
  if (refund.amount > recorded) {
    await addTimelineEntry(
      tx,
      tenant.shopId,
      order.id,
      tenant.actor,
      'refunded',
      `${format(refund.amount - recorded)} given back ${via} beyond what was paid on the order ` +
        'and not refunded yet',
    );
  }
  return { refundId };
}

/**
 * Records a refund of `amount` on `order`, locked, in the caller's transaction, no more than was
 * paid on it and not refunded yet: its share of the order's sales tax (ADR-105), the order's
 * amount refunded and financial status, its timeline entry `message`, its event and its audit
 * entry. Returns the refund's ID, and the order as it is now.
 */
export async function writeRefund(
  tx: Tx,
  tenant: TenantContext,
  order: OrderRow,
  refund: {
    amount: bigint;
    method: RefundMethodValue;
    reference: string | null;
    note: string;
    /** Its receipt, kept among the order's (ADR-242). */
    receipt?: StoredReceipt | null;
    message: string;
  },
): Promise<{ refundId: string; order: OrderRow }> {
  const { amount } = refund;
  const orderId = order.id;
  if (amount > order.amountPaid - order.amountRefunded) {
    throw new Error('A refund is no more than what was paid and not refunded yet');
  }
  // What of it was sales tax: the order's tax in all it has refunded, less what the refunds
  // before it gave back (ADR-105).
  const [before] = await tx
    .select({ tax: sql<string>`coalesce(sum(${refunds.tax}), 0)::text` })
    .from(refunds)
    .where(and(eq(refunds.shopId, tenant.shopId), eq(refunds.orderId, orderId)));
  const tax = refundTaxOf(order, amount, BigInt(before!.tax));
  const refundId = newId();
  const actor = actorColumnsOf(tenant.actor);
  await tx.insert(refunds).values({
    shopId: tenant.shopId,
    id: refundId,
    orderId,
    amount,
    tax,
    method: refund.method,
    reference: refund.reference,
    note: refund.note,
    receiptKey: refund.receipt?.key ?? null,
    receiptContentType: refund.receipt?.contentType ?? null,
    receiptSize: refund.receipt?.size ?? null,
    actorKind: actor.actorKind,
    actorId: actor.actorId,
  });
  const amountRefunded = order.amountRefunded + amount;
  const updated = await updateOrder(tx, tenant.shopId, order, {
    amountRefunded,
    financialStatus: amountRefunded === order.amountPaid ? 'refunded' : 'partially_refunded',
  });
  await addTimelineEntry(tx, tenant.shopId, orderId, tenant.actor, 'refunded', refund.message);
  await appendEvent<OrderRefundedPayload>(tx, tenant.shopId, {
    type: OrderEvents.OrderRefunded,
    aggregateType: 'order',
    aggregateId: orderId,
    payload: {
      refundId,
      amount: amount.toString(),
      amountRefunded: amountRefunded.toString(),
      tax: tax.toString(),
      method: refund.method,
      stage: updated.stage,
      version: updated.version,
    },
  });
  await recordAudit(tx, tenant.shopId, {
    action: 'order.refunded',
    subjectType: 'order',
    subjectId: orderId,
    ...actor,
    // As the API has them: a public ID, an amount in major units, the method's enum value.
    details: {
      number: order.number,
      refundId: toPublicId('refund', refundId),
      amount: toMajorString(money(amount, order.currency as CurrencyCode)),
      tax: toMajorString(money(tax, order.currency as CurrencyCode)),
      method: refund.method.toUpperCase(),
    },
  });
  return { refundId, order: updated };
}
