// The orders module's public surface. Everything under src/internal is private to this module.
export { checkAddress, type AddressInput } from '../internal/address.js';
export {
  VISIT_DAYS,
  attributionOf,
  type AttributionValue,
  type UtmValue,
  type VisitValue,
} from '../internal/attribution.js';
export {
  AgentPerformanceService,
  type AgentPerformanceInput,
  type AgentPerformanceRow,
} from '../internal/agent-performance.service.js';
export { BROWSER_ID_LIMIT, browserIdsOf, type BrowserIdsValue } from '../internal/browser-ids.js';
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
  chargeParcelsIn,
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
export { orderConversionFactsIn, type OrderConversionFacts } from '../internal/conversion-facts.js';
export {
  CustomerAnswers,
  messageLinkIn,
  type AnswerOutcome,
  type CustomerAnswer,
} from '../internal/customer-answers.js';
export {
  orderNotificationFactsIn,
  type OrderNotificationFacts,
} from '../internal/notification-facts.js';
export { mentionsIn, staffAlertFactsIn, type StaffAlertFacts } from '../internal/staff-alerts.js';
export { ORDER_SEGMENT_FACTS, customerFactsQuery } from '../internal/customer-facts.js';
export {
  orderShipmentFactsIn,
  parcelShipmentFactsIn,
  type OrderShipmentFacts,
  type ParcelShipmentFacts,
} from '../internal/shipment-facts.js';
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
export {
  chosenGateway,
  gatewayNames,
  gatewayOrigins,
  onlinePaidNotice,
  onlinePaymentProblemWords,
  payOnlineForm,
  gatewayForm,
  type GatewayFormStart,
  type OnlinePaymentProblem,
} from '../internal/online-payment-page.js';
export {
  OnlinePayments,
  orderBuyerIn,
  orderPaymentFactsIn,
  receiveOnlinePaymentIn,
  type OnlineGateway,
  type OnlinePaymentReceipt,
  type OrderBuyerFacts,
  type OrderPaymentFacts,
} from '../internal/online-payments.js';
export { OrderCommentService } from '../internal/order-comment.service.js';
export {
  OrderEditService,
  type OrderChargesEdit,
  type OrderLineItemsEdit,
  type OrderLineQuantityInput,
  type OrderSplitInput,
  type OrderSplitLineInput,
} from '../internal/order-edit.service.js';
export {
  ReturnService,
  type OpenReturnRecord,
  type OpenReturnsOptions,
  type ReturnCreateInput,
  type ReturnLineInput,
  type ReturnRestockInput,
  type ReturnResult,
} from '../internal/return.service.js';
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
  PREPAID_DISCOUNT_MAX_BPS,
  auditedPrepaidDiscount,
  checkPrepaidDiscount,
  prepaidDiscountOf,
  samePrepaidDiscount,
  type PrepaidDiscountInput,
  type PrepaidDiscountValue,
} from '../internal/prepaid-discount.js';
export {
  EXPORT_FORMATS,
  EXPORT_LAYOUTS,
  EXPORT_LIMITS,
  EXPORT_ROLES,
  OrderExportService,
  type ExportFormatValue,
  type ExportLayoutValue,
  type OrderExportFile,
  type OrderExportInput,
  type OrderExportResult,
} from '../internal/order-export.service.js';
export type { OrderFilter } from '../internal/order-filter.js';
export {
  EXPORT_FREQUENCIES,
  EXPORT_SCHEDULE_LIMITS,
  ExportScheduleService,
  type ExportFrequencyValue,
  type ExportRunOutcome,
  type ExportScheduleInput,
  type ExportScheduleRecord,
} from '../internal/export-schedule.service.js';
export {
  ScheduledExportSender,
  exportPeriod,
  periodFilename,
  scheduledExportEmail,
  type ExportPeriod,
  type ScheduledExportEmail,
} from '../internal/export-schedule-email.js';
export {
  OrderEvents,
  type BankTransferSettingsUpdatedPayload,
  type OrderAssignedPayload,
  type OrderCommentPayload,
  type DraftOrderCompletedPayload,
  type DraftOrderCreatedPayload,
  type DraftOrderDeletedPayload,
  type DraftOrderUpdatedPayload,
  type FulfillmentCreatedPayload,
  type FulfillmentEventCreatedPayload,
  type FulfillmentUpdatedPayload,
  type ReturnPayload,
  type OrderCancelledPayload,
  type OrderConfirmedPayload,
  type OrderCreatedPayload,
  type OrderExportCreatedPayload,
  type OrderPaidPayload,
  type OrderPaymentRemindedPayload,
  type OrderConfirmationRemindedPayload,
  type OrderReceiptsErasedPayload,
  type OrderRefundedPayload,
  type OrderUpdatedPayload,
  type RiskSettingsUpdatedPayload,
} from '../internal/events.js';
export {
  FulfillmentService,
  type ParcelCaller,
  type ClaimInput,
  type ClaimSettlementInput,
  type FulfillInput,
  type LostParcelClaimFilter,
  type LostParcelRecord,
  type LostParcelsOptions,
  type FulfillmentEventInput,
  type ParcelResult,
  type RestockInput,
  type TrackingInput,
} from '../internal/fulfillment.service.js';
export { RECORDED_EVENT_STATUSES, fulfillmentEventsIn } from '../internal/fulfillment-events.js';
export {
  CLAIM_LIMITS,
  PAYABLE_CLAIMS,
  parcelStatesIn,
  payClaimsIn,
  type ParcelState,
} from '../internal/parcel-claims.js';
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
export { taxByRate } from '../internal/order-tax.js';
export {
  RefundService,
  refundOnlinePaymentIn,
  type RefundInput,
  type RefundResult,
} from '../internal/refund.service.js';
export {
  SALES_DIMENSIONS,
  SALES_INTERVALS,
  SalesReportService,
  averageOrderValue,
  grossProfit,
  netSales,
  profit,
  type ProductSales,
  type SalesDimension,
  type SalesIntervalValue,
  type SalesPeriod,
  type SalesReport,
  type SalesReportInput,
  type SalesRow,
  type SalesTally,
} from '../internal/sales-report.service.js';
export {
  SavedSearchService,
  type SavedSearchInput,
  type SavedSearchUpdateInput,
} from '../internal/saved-search.service.js';
export { TodayService, type OrderToday } from '../internal/today.service.js';
export { OrdersModule } from '../internal/orders.module.js';
export { Order, OrderAgreement, OrderEvent } from '../internal/graphql/order.types.js';
export { DocumentLanguage, PaperSize } from '../internal/graphql/document.types.js';
export { SalesInterval } from '../internal/graphql/sales-report.types.js';
export { toOrder } from '../internal/graphql/mappers.js';
export {
  NO_ORDERS,
  type CustomerOrderStats,
  type DraftOrderLineRecord,
  type DraftOrderRecord,
  type FulfillmentEventRecord,
  type FulfillmentRecord,
  type OrderAgreementRecord,
  type OrderEventRecord,
  type OrderHome,
  type OrderLineRecord,
  type OrderRecord,
  type OrderRiskRecord,
  type OrderTally,
  type ParcelClaimRecord,
  type RefundRecord,
  type ReturnRecord,
} from '../internal/records.js';
export { RiskSettingsService, type RiskSettingsInput } from '../internal/risk-settings.service.js';
export {
  CONFIRMATION_REMINDER,
  DEFAULT_ORDER_SETTINGS,
  OrderSettingsService,
  UNPAID_LIMITS,
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
  cashPastLimitOf,
  codLimitError,
  awaitsCustomer,
  draftName,
  orderName,
  transferOwed,
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
  FulfillmentEventStatusValue,
  FulfillmentStatusValue,
  OrderSourceValue,
  OrderStageValue,
  OrderStatusValue,
  ParcelClaimStatusValue,
  ParcelStatusValue,
  PaymentMethodValue,
  RefundMethodValue,
  RiskLevelValue,
  RiskReasonValue,
} from '../internal/schema.js';
export { FULFILLMENT_EVENT_STATUSES } from '../internal/schema.js';
