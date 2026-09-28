// The orders module's public surface. Everything under src/internal is private to this module.
export type { AddressInput } from '../internal/address.js';
export { ORDER_SEGMENT_FACTS, customerFactsQuery } from '../internal/customer-facts.js';
export {
  OrderEvents,
  type FulfillmentCreatedPayload,
  type FulfillmentUpdatedPayload,
  type OrderCancelledPayload,
  type OrderConfirmedPayload,
  type OrderCreatedPayload,
  type OrderPaidPayload,
  type OrderUpdatedPayload,
  type RiskSettingsUpdatedPayload,
} from '../internal/events.js';
export {
  FulfillmentService,
  type FulfillInput,
  type ParcelResult,
  type RestockInput,
  type TrackingInput,
} from '../internal/fulfillment.service.js';
export {
  OrderService,
  type CancelOptions,
  type ListOrdersOptions,
  type OrderCreateInput,
  type OrderLineInput,
  type OrderUpdateInput,
} from '../internal/order.service.js';
export type { RiskSettingsRecord } from '../internal/order-risk.js';
export { OrdersModule } from '../internal/orders.module.js';
export {
  NO_ORDERS,
  type CustomerOrderStats,
  type FulfillmentRecord,
  type OrderEventRecord,
  type OrderLineRecord,
  type OrderRecord,
  type OrderRiskRecord,
} from '../internal/records.js';
export { RiskSettingsService, type RiskSettingsInput } from '../internal/risk-settings.service.js';
export { FIRST_ORDER_NUMBER, orderName } from '../internal/rules.js';
export type {
  AddressValue,
  CancelReasonValue,
  ConfirmationStatusValue,
  FinancialStatusValue,
  FulfillmentStatusValue,
  OrderSourceValue,
  OrderStageValue,
  OrderStatusValue,
  ParcelStatusValue,
  PaymentMethodValue,
  RiskLevelValue,
  RiskReasonValue,
} from '../internal/schema.js';
