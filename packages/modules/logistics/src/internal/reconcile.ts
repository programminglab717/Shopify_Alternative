import { PAYABLE_CLAIMS, type CourierParcel, type OrderCod } from '@hatti/orders/public';
import type { CodRemittanceLineRecord } from './records.js';
import type { StatementLine } from './statement.js';

/**
 * Which of the parcels with a line's tracking number it is: the one the statement's courier
 * shipped, as staff named it, else the most recently shipped.
 */
export function parcelFor(
  candidates: readonly CourierParcel[],
  courier: string,
): CourierParcel | null {
  const named = courier.trim().toLowerCase();
  return (
    candidates.find((parcel) => parcel.trackingCompany?.trim().toLowerCase() === named) ??
    candidates[0] ??
    null
  );
}

/**
 * What becomes of each line of a statement, in its order, given its parcel (null for none),
 * what the parcels' orders owe, and the parcels whose cash earlier statements collected:
 * * no parcel: `unmatched`;
 * * a parcel an earlier line or statement collected cash on: `repeated`, so that a statement
 *   imported twice is not received twice;
 * * cash on a parcel the courier lost: `compensated`, paying its claim, filed or not, unless the
 *   shop settled the claim otherwise, paid by hand or withdrawn: `not_owed` (ADR-093);
 * * no cash on a parcel coming or come back: `charged`, the courier's charges alone;
 * * an order that owes nothing, or is not open cash on delivery: `not_owed`, or `charged` for a
 *   line with no cash;
 * * else the cash, at most what the order still owes, is received: `received` when it is what
 *   the order owed, `short` when less and `over` when more. An order's lines take from what it
 *   owes in turn.
 */
export function reconcile(
  lines: readonly StatementLine[],
  parcels: readonly (CourierParcel | null)[],
  orders: ReadonlyMap<string, OrderCod>,
  collectedBefore: ReadonlySet<string>,
): CodRemittanceLineRecord[] {
  const remaining = new Map(
    [...orders.values()].map((order) => [order.id, order.payable ? order.owed : 0n]),
  );
  const seen = new Set<string>();
  return lines.map((line, index) => {
    const parcel = parcels[index] ?? null;
    const base = {
      row: line.row,
      trackingNumber: line.trackingNumber,
      collected: line.collected,
      charges: line.charges,
      tax: line.tax,
    };
    if (!parcel) {
      return {
        ...base,
        fulfillmentId: null,
        orderId: null,
        orderNumber: null,
        outcome: 'unmatched',
        owed: null,
        received: 0n,
      };
    }
    const matched = {
      ...base,
      fulfillmentId: parcel.id,
      orderId: parcel.orderId,
      orderNumber: orders.get(parcel.orderId)?.number ?? null,
    };
    const owed = remaining.get(parcel.orderId) ?? 0n;
    const repeated = seen.has(parcel.id) || (line.collected > 0n && collectedBefore.has(parcel.id));
    seen.add(parcel.id);
    if (repeated) return { ...matched, outcome: 'repeated', owed, received: 0n };
    if (line.collected > 0n && parcel.status === 'lost') {
      const payable = PAYABLE_CLAIMS.includes(parcel.claimStatus);
      return { ...matched, outcome: payable ? 'compensated' : 'not_owed', owed, received: 0n };
    }
    const sentBack = parcel.status === 'returning' || parcel.status === 'returned';
    if (line.collected === 0n && sentBack) {
      return { ...matched, outcome: 'charged', owed, received: 0n };
    }
    if (owed <= 0n) {
      return {
        ...matched,
        outcome: line.collected > 0n ? 'not_owed' : 'charged',
        owed,
        received: 0n,
      };
    }
    const received = line.collected < owed ? line.collected : owed;
    remaining.set(parcel.orderId, owed - received);
    const outcome = line.collected === owed ? 'received' : line.collected < owed ? 'short' : 'over';
    return { ...matched, outcome, owed, received };
  });
}
