import {
  InputChecker,
  actorColumnsOf,
  failOne,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import { Database, type Tx } from '@hatti/db';
import { appendEvent, recordAudit } from '@hatti/events';
import { newId, toPublicId } from '@hatti/ids';
import { formatMoney, money, toMajorString, type CurrencyCode } from '@hatti/money';
import { Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { OrderEvents, type OrderRefundedPayload } from './events.js';
import { addTimelineEntry, loadOrder, lockOrder, updateOrder } from './order-store.js';
import { refundTaxOf } from './order-tax.js';
import type { OrderRecord, RefundRecord } from './records.js';
import { LIMITS } from './rules.js';
import { refunds, type OrderRow, type RefundMethodValue } from './schema.js';

export interface RefundInput {
  /** In major units, like "2,000" or "499.50". */
  amount: string;
  method: RefundMethodValue;
  /** The transfer's reference, such as a wallet transaction ID. */
  reference?: string | null;
  /** Why, for the shop's records. */
  note?: string | null;
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
};

@Injectable()
export class RefundService {
  constructor(private readonly db: Database) {}

  /**
   * Records money given back on an order, up to what was paid on it and not refunded yet. Hatti
   * moves no money: staff send it, then record it here. The order's financial status becomes
   * refunded, or partially refunded, and its stage stays as it is: a completed order stays
   * completed. The timeline, the outbox and the audit log each get an entry.
   */
  async refund(
    tenant: TenantContext,
    orderId: string,
    input: RefundInput,
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
    if (!check.ok || amount === null) return { ok: false, errors: check.errors };

    return this.db.tenant(tenant.shopId, async (tx): Promise<MutationResult<RefundResult>> => {
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

      const { refundId } = await writeRefund(tx, tenant, order, {
        amount,
        method: input.method,
        reference,
        note,
        message: `Refunded ${format(amount)}${METHOD_TEXT[input.method]}`,
      });
      const record = (await loadOrder(tx, tenant.shopId, orderId))!;
      const refund = record.refunds.find((entry) => entry.id === refundId)!;
      return { ok: true, value: { order: record, refund } };
    });
  }
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
