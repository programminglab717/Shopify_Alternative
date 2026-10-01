// The orders module's public surface. Everything under src/internal is private to this module.
export { checkAddress, type AddressInput } from '../internal/address.js';
export {
  BANK_TRANSFER_LIMITS,
  BankTransferService,
  bankTransferSettingsIn,
  offeredBankTransferIn,
  type BankAccountInput,
  type BankTransferSettingsInput,
  type BankTransferSettingsRecord,
  type OfferedBankTransfer,
} from '../internal/bank-transfer.service.js';
export {
  COD_HEALTH_DIMENSIONS,
  CodHealthService,
  type CodConfirmationTally,
  type CodDeliveryTally,
  type CodHealthDimension,
  type CodHealthInput,
  type CodHealthReport,
  type CodHealthRow,
} from '../internal/cod-health.service.js';
export {
  codOwedIn,
  parcelsByTrackingIn,
  receiveCodIn,
  trackingKey,
  type CourierParcel,
  type OrderCod,
} from '../internal/cod-cash.js';
export {
  CodReceivablesService,
  RECEIVABLE_AGES,
  type CodCash,
  type CodReceivables,
  type CourierReceivables,
  type ReceivableAge,
} from '../internal/cod-receivables.service.js';
export {
  CONFIRMATION_DESK,
  ConfirmationDeskService,
  type ConfirmationCallInput,
  type ConfirmationCallRecord,
  type ConfirmationQueue,
  type ConfirmationQueueItem,
} from '../internal/confirmation-desk.service.js';
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
export {
  draftLinkPage,
  orderLinkPage,
  type LinkPage,
  type LinkPageOptions,
} from '../internal/link-pages.js';
export {
  DRAFT_LINK_PATH,
  ORDER_LINK_PATH,
  type AddressForm,
  type LinkProblem,
  type LinkShop,
} from '../internal/links.js';
export { ORDER_CUSTOMER_DATA } from '../internal/order-customer-data.js';
export { transferDetails, transferWords } from '../internal/transfer-details.js';
export {
  RECEIPT_LIMITS,
  RECEIPT_TYPES,
  TransferReceiptService,
  type ReceiptUpload,
  type TransferReceiptRecord,
} from '../internal/transfer-receipt.service.js';
export {
  TRANSFER_DISCOUNT_MAX_BPS,
  transferDiscountOf,
  type TransferDiscountInput,
  type TransferDiscountValue,
} from '../internal/transfer-discount.js';
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
  type BankTransferSettingsUpdatedPayload,
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
  type CheckedOrderUpdate,
  type ListOrdersOptions,
  type OrderAgreementInput,
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
export {
  SALES_INTERVALS,
  SalesReportService,
  averageOrderValue,
  netSales,
  type ProductSales,
  type SalesIntervalValue,
  type SalesPeriod,
  type SalesReport,
  type SalesReportInput,
  type SalesTally,
} from '../internal/sales-report.service.js';
export { OrdersModule } from '../internal/orders.module.js';
export { OrderAgreement } from '../internal/graphql/order.types.js';
export {
  NO_ORDERS,
  type CustomerOrderStats,
  type DraftOrderLineRecord,
  type DraftOrderRecord,
  type FulfillmentRecord,
  type OrderAgreementRecord,
  type OrderEventRecord,
  type OrderHome,
  type OrderLineRecord,
  type OrderRecord,
  type OrderRiskRecord,
  type OrderTally,
  type RefundRecord,
} from '../internal/records.js';
export { RiskSettingsService, type RiskSettingsInput } from '../internal/risk-settings.service.js';
export {
  DEFAULT_ORDER_SETTINGS,
  OrderSettingsService,
  orderSettingsIn,
  type OrderSettingsInput,
  type OrderSettingsRecord,
} from '../internal/order-settings.service.js';
export {
  COD_CASH_LIMIT,
  FIRST_ORDER_NUMBER,
  LIMITS as ORDER_LIMITS,
  LINK_HOURS,
  addressChangeable,
  awaitsTransfer,
  codLimitError,
  awaitsCustomer,
  draftName,
  orderName,
} from '../internal/rules.js';
export type {
  AddressValue,
  BankAccountValue,
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
