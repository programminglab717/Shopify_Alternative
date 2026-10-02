import type { OrderShipmentFacts } from '@hatti/orders/public';
import { parsePkMobile } from '@hatti/pk';
import type { CourierShipment } from './couriers.js';

/** How long couriers' descriptions of a parcel's contents may be. */
const CONTENTS_MAX = 500;

/**
 * The parcel a courier is asked to book for the order (SHP-02): to its customer at its address,
 * the courier collecting what the order owes; or why it cannot be, in words staff act on.
 */
export function courierShipmentOf(
  order: OrderShipmentFacts,
  place: { city: string; pickupCode: string | null },
): CourierShipment | { refusal: string } {
  const address = order.address;
  if (!address) {
    return { refusal: "The customer's details on this order were erased at their request" };
  }
  const phone = parsePkMobile(address.phone);
  if (!phone) {
    return { refusal: "The customer's number is not a mobile number couriers take" };
  }
  return {
    reference: order.name,
    customerName: address.name,
    customerPhone: phone.national,
    address: [address.address1, address.address2, address.landmark]
      .filter((part) => part !== null && part.trim() !== '')
      .join(', '),
    city: place.city,
    codAmount: order.codAmount,
    pieces: order.items.reduce((sum, item) => sum + item.quantity, 0),
    contents: order.items
      .map((item) => (item.quantity > 1 ? `${item.title} x ${item.quantity}` : item.title))
      .join(', ')
      .slice(0, CONTENTS_MAX),
    weightGrams: order.weightGrams,
    pickupCode: place.pickupCode,
  };
}
