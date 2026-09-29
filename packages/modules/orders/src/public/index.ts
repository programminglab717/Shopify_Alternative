// The orders module's public surface. Everything under src/internal is private to this module.
export type { AddressInput } from '../internal/address.js';
export { ORDER_SEGMENT_FACTS, customerFactsQuery } from '../internal/customer-facts.js';
export {
  OrderDocumentService,
  type DocumentRequest,
  type OrderDocumentRecord,
} from '../internal/document.service.js';
export { DOCUMENT_KINDS, type DocumentKindValue } from '../internal/documents.js';
export {
  DraftOrderService,
  type DraftLinkView,
  type DraftOrderInput,
  type DraftOrderLink,
  type ListDraftOrdersOptions,
} from '../internal/draft-order.service.js';
export { draftLinkPage, orderLinkPage, type LinkPage } from '../internal/link-pages.js';
export {
  DRAFT_LINK_PATH,
  ORDER_LINK_PATH,
  type LinkProblem,
  type LinkShop,
} from '../internal/links.js';
export { ORDER_CUSTOMER_DATA } from '../internal/order-customer-data.js';
export {
  EXPORT_LAYOUTS,
  EXPORT_LIMITS,
  OrderExportService,
  type ExportLayoutValue,
  type OrderExportInput,
  type OrderExportResult,
} from '../internal/order-export.service.js';
export type { OrderFilter } from '../internal/order-filter.js';
export {
  OrderEvents,
  type DraftOrderCompletedPayload,
  type DraftOrderCreatedPayload,
  type DraftOrderDeletedPayload,
  type DraftOrderUpdatedPayload,
  type FulfillmentCreatedPayload,
  type FulfillmentUpdatedPayload,
  type OrderCancelledPayload,
  type OrderConfirmedPayload,
  type OrderCreatedPayload,
  type OrderExportCreatedPayload,
  type OrderPaidPayload,
  type OrderRefundedPayload,
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
  type BulkResult,
  type CancelOptions,
  type ListOrdersOptions,
  type OrderCreateInput,
  type OrderLineInput,
  type OrderToPlace,
  type OrderUpdateInput,
  type Placement,
} from '../internal/order.service.js';
export {
  OrderLinkService,
  type OrderLink,
  type OrderLinkView,
} from '../internal/order-link.service.js';
export type { RiskSettingsRecord } from '../internal/order-risk.js';
export { RefundService, type RefundInput, type RefundResult } from '../internal/refund.service.js';
export { OrdersModule } from '../internal/orders.module.js';
export {
  NO_ORDERS,
  type CustomerOrderStats,
  type DraftOrderLineRecord,
  type DraftOrderRecord,
  type FulfillmentRecord,
  type OrderEventRecord,
  type OrderLineRecord,
  type OrderRecord,
  type OrderRiskRecord,
  type RefundRecord,
} from '../internal/records.js';
export { RiskSettingsService, type RiskSettingsInput } from '../internal/risk-settings.service.js';
export {
  FIRST_ORDER_NUMBER,
  LINK_HOURS,
  awaitsCustomer,
  draftName,
  orderName,
} from '../internal/rules.js';
export type {
  AddressValue,
  CancelReasonValue,
  DraftOrderSourceValue,
  DraftOrderStatusValue,
  ErasedAddressValue,
  StoredAddressValue,
  ConfirmationStatusValue,
  FinancialStatusValue,
  FulfillmentStatusValue,
  OrderSourceValue,
  OrderStageValue,
  OrderStatusValue,
  ParcelStatusValue,
  PaymentMethodValue,
  RefundMethodValue,
  RiskLevelValue,
  RiskReasonValue,
} from '../internal/schema.js';
