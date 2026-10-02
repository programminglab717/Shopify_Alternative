// The logistics module's public surface. Everything under src/internal is private to this module.
export {
  BOOKING_LIMITS,
  BOOKING_STATUSES,
  CourierBookingService,
  TRACK_EVERY_MS,
  TRACK_FOR_MS,
  type BookOrdersInput,
  type BookOrdersResult,
  type BookingStatusValue,
  type ClaimedBooking,
  type CourierBookingRecord,
  type TrackedBooking,
} from '../internal/bookings.service.js';
export {
  COURIERS,
  COURIER_ACCOUNT_LIMITS,
  CourierAccountService,
  type CourierAccountInput,
  type CourierAccountRecord,
  type OpenedCourierAccount,
} from '../internal/courier-accounts.service.js';
export {
  COURIER_PARCEL_STATUSES,
  Couriers,
  POSTEX_API_URL,
  PostExCourier,
  TestCourier,
  plainStatusOf,
  type CourierAdapter,
  type CourierCredentials,
  type CourierInfo,
  type CourierParcelStatusValue,
  type CourierResult,
  type CourierShipment,
  type CourierTracking,
} from '../internal/couriers.js';
export {
  LogisticsEvents,
  type CodRemittanceImportedPayload,
  type CourierAccountChangedPayload,
  type CourierBookingPayload,
  type ShipmentStatusChangedPayload,
} from '../internal/events.js';
export { LogisticsModule } from '../internal/logistics.module.js';
export type { CodRemittanceLineRecord, CodRemittanceRecord } from '../internal/records.js';
export {
  CodRemittanceService,
  type RemittanceImport,
  type RemittanceImportInput,
} from '../internal/remittance.service.js';
export { REMITTANCE_OUTCOMES, type RemittanceOutcomeValue } from '../internal/schema.js';
export { STATEMENT_LIMITS, amountOf, headingKey } from '../internal/statement.js';
export { courierShipmentOf } from '../internal/shipments.js';
