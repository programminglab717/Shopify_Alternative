import type { CourierParcelStatusValue } from './couriers.js';

/** Events the logistics module publishes. Payloads are thin: fetch current state through the API. */
export const LogisticsEvents = {
  /** A courier's remittance statement was imported, and its cash received on orders. */
  CodRemittanceImported: 'cod_remittance.imported',
  /** The shop connected an account with a courier (SHP-01). */
  CourierAccountConnected: 'courier_account.connected',
  CourierAccountUpdated: 'courier_account.updated',
  /** No more bookings with the account; its bookings waiting were cancelled. */
  CourierAccountArchived: 'courier_account.archived',
  /** Staff or an app asked for an order to be booked with a courier (SHP-02). */
  CourierBookingRequested: 'courier_booking.requested',
  /** The courier booked the order, and it shipped as a parcel with the courier's number. */
  CourierBookingBooked: 'courier_booking.booked',
  /** The courier could not book the order, or the order could not be shipped. */
  CourierBookingFailed: 'courier_booking.failed',
  /** The booking was cancelled while it waited. */
  CourierBookingCancelled: 'courier_booking.cancelled',
  /** What the courier says of a booked parcel changed (SHP-04). */
  ShipmentStatusChanged: 'shipment.status_changed',
} as const;

export interface CodRemittanceImportedPayload {
  courier: string;
  reference: string | null;
  lineCount: number;
  /** Minor units, as strings: the cash the courier collected, and what was received on orders. */
  collected: string;
  received: string;
}

export interface CourierAccountChangedPayload {
  courier: string;
  /** For updates: what changed, such as ["credentials", "isDefault"]. */
  changed?: string[];
  actorKind: 'staff' | 'app';
  actorId: string;
}

export interface CourierBookingPayload {
  orderId: string;
  accountId: string;
  courier: string;
  /** Booked: the courier's number and the parcel shipped with it. */
  trackingNumber?: string | null;
  fulfillmentId?: string | null;
  /** Failed: why. */
  error?: string | null;
}

export interface ShipmentStatusChangedPayload {
  orderId: string;
  fulfillmentId: string | null;
  courier: string;
  trackingNumber: string;
  from: CourierParcelStatusValue | null;
  to: CourierParcelStatusValue;
  /** As the courier said it. */
  courierStatus: string;
}
