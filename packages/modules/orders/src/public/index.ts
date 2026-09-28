// The orders module's public surface. Everything under src/internal is private to this module.
export type { AddressInput } from '../internal/address.js';
export {
  OrderEvents,
  type OrderCancelledPayload,
  type OrderConfirmedPayload,
  type OrderCreatedPayload,
  type OrderPaidPayload,
  type OrderUpdatedPayload,
} from '../internal/events.js';
export {
  OrderService,
  type CancelOptions,
  type ListOrdersOptions,
  type OrderCreateInput,
  type OrderLineInput,
  type OrderUpdateInput,
} from '../internal/order.service.js';
export { OrdersModule } from '../internal/orders.module.js';
export type { OrderEventRecord, OrderLineRecord, OrderRecord } from '../internal/records.js';
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
  PaymentMethodValue,
} from '../internal/schema.js';
