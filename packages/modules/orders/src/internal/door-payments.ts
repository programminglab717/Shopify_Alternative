import type { Tx } from '@hatti/db';
import { lockOrder, updateOrder } from './order-store.js';
import { doorOwed } from './rules.js';

// Paying online at the door (PAY-09, ADR-846): while the shop's own rider has a cash-on-delivery
// order's parcel out (ADR-825), its page offers what the rider would collect, to pay online
// instead; paid, the cash to collect comes down (`receiveOnlinePaymentIn`), and the rider's page
// reads it. The rider's module opens it when it hands the parcel out, and closes it once the
// parcel is delivered or comes back. A courier's parcel is never opened: no courier takes a
// change of the cash to collect once it is booked.

/**
 * Opens the door of the order `orderId` to paying online, in the caller's transaction `tx`, for
 * its parcel `parcelId` the shop's own rider takes out: a cash-on-delivery order, open, with cash
 * to collect. Returns whether it did.
 */
export async function openDoorPaymentIn(
  tx: Tx,
  shopId: string,
  orderId: string,
  parcelId: string,
): Promise<boolean> {
  const order = await lockOrder(tx, shopId, orderId);
  if (!order || doorOwed({ ...order, doorParcelId: parcelId }) === 0n) return false;
  if (order.doorParcelId !== parcelId) {
    await updateOrder(tx, shopId, order, { doorParcelId: parcelId });
  }
  return true;
}

/**
 * Closes the door of the order `orderId` to paying online, in the caller's transaction `tx`, once
 * its parcel `parcelId` is delivered or comes back; a door another parcel opened stays open.
 */
export async function closeDoorPaymentIn(
  tx: Tx,
  shopId: string,
  orderId: string,
  parcelId: string,
): Promise<void> {
  const order = await lockOrder(tx, shopId, orderId);
  if (order?.doorParcelId === parcelId) {
    await updateOrder(tx, shopId, order, { doorParcelId: null });
  }
}
