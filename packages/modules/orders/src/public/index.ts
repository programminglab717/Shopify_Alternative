// The orders module's public surface. Everything under src/internal is private to this module.
export { checkAddress, type AddressInput } from '../internal/address.js';
export {
  LOCATION_SCRIPT,
  MAP_SCRIPT,
  MapTiles,
  locationField,
  locationFormOf,
  mapUrlOf,
  pinCode,
  pinLine,
  type LocationForm,
} from '../internal/location.js';
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
export {
  PackerPerformanceService,
  type PackerPerformanceInput,
  type PackerPerformanceRow,
} from '../internal/packer-performance.service.js';
export { savedAddressIn, type SavedAddress } from '../internal/saved-address.js';
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
export { closeDoorPaymentIn, openDoorPaymentIn } from '../internal/door-payments.js';
export { SUPPORT_FACTS_ORDERS, supportFactsIn } from '../internal/support-facts.js';
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
  overdueFirstCallsIn,
  type OverdueFirstCalls,
  type ConfirmationCallInput,
  type ConfirmationCallRecord,
  type ConfirmationQueue,
  type ConfirmationQueueItem,
} from '../internal/confirmation-desk.service.js';
export { orderConversionFactsIn, type OrderConversionFacts } from '../internal/conversion-facts.js';
export { DESK_DUTY, DeskDutyService, type DeskDutyRecord } from '../internal/desk-duty.js';
export {
  accountOrderLinkIn,
  accountOrdersIn,
  type AccountOrderFacts,
  type AccountOrderItemFacts,
  type AccountOrderWithItems,
} from '../internal/account-orders.js';
export {
  CustomerAnswers,
  messageLinkIn,
  type AnswerOutcome,
  type CustomerAnswer,
} from '../internal/customer-answers.js';
export {
  DELIVERY_RESCUE_LIMITS,
  DeliveryRescueService,
  RESCUE_ANSWER_VALUES,
  type DeliveriesToRescue,
  type DeliveryToRescue,
  type RescueAnswerValue,
} from '../internal/delivery-rescue.service.js';
// Areas riders struggle to find houses in, learned from the shop's parcels (ADR-717).
export { HARD_TO_FIND, hardToFindIn } from '../internal/hard-to-find.js';
// A pin from a map's link or coordinates (ADR-718).
export { MAP_LINK_LIMITS, pointInText, pointOfMapLink } from '../internal/map-links.js';
export {
  REVIEW_REQUEST_LIMITS,
  markReviewRequestedIn,
  reviewRequestsDueIn,
  shopsAskingForReviewsIn,
  type ReviewRequestDue,
} from '../internal/review-requests.js';
export {
  orderNotificationFactsIn,
  type OrderNotificationFacts,
} from '../internal/notification-facts.js';
export {
  orderGiftCardFactsIn,
  paidOrdersWithProductIn,
  type OrderGiftCardFacts,
} from '../internal/gift-card-facts.js';
export { orderCashbackFactsIn, type OrderCashbackFacts } from '../internal/cashback-facts.js';
export {
  customerOrderTracesIn,
  orderReferralFactsIn,
  referralCodeOf,
  type CustomerOrderTraces,
  type OrderReferralFacts,
  type OrderTrace,
} from '../internal/referral-facts.js';
export {
  BOUGHT_TOGETHER,
  BOUGHT_TOGETHER_ORDERS,
  boughtTogetherIn,
} from '../internal/bought-together.js';
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
  trackingPage,
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
  offerPrepayIn,
  receiveOnlinePaymentIn,
  type OnlineGateway,
  type OnlinePaymentReceipt,
  type OrderBuyerFacts,
  type OrderPaymentFacts,
} from '../internal/online-payments.js';
export { OrderCommentService } from '../internal/order-comment.service.js';
export {
  PAST_ORDER_CUSTOMER_DATA,
  PastOrderService,
  majorOf,
  pastOrdersOfCustomerIn,
  type PastOrderAddress,
  type PastOrderInput,
  type PastOrderLine,
  type PastOrderRecord,
  type PastOrderSource,
} from '../internal/past-orders.js';
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
export {
  ReturnRequestService,
  type ReturnOffer,
  type ReturnRequestForm,
  returnRequestNoticeIn,
  type ReturnRequestNotice,
  type ReturnRequestRecord,
} from '../internal/return-request.service.js';
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
  type ReturnRequestPayload,
  type OrderCancelledPayload,
  type OrderConfirmedPayload,
  type OrderCreatedPayload,
  type OrderExportCreatedPayload,
  type OrderPaidPayload,
  type OrderPaymentRemindedPayload,
  type OrderConfirmationRemindedPayload,
  type OrderConfirmationCalledPayload,
  type OrderReceiptsErasedPayload,
  type OrderRefundedPayload,
  type OrderUpdatedPayload,
  type PlanOrdersCountedPayload,
  type RiskSettingsUpdatedPayload,
} from '../internal/events.js';
export { OVER_LIMIT_MESSAGE } from '../internal/plan-orders.js';
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
  ordersToShipOfCustomerIn,
  type OrderToShip,
  type RefusedOrders,
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
  type UnpaidWait,
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
  CUSTOM_REPORT_LIMITS,
  CustomReportService,
  REPORT_BREAKDOWNS,
  REPORT_PERIODS,
  type CustomReportRecord,
  type ReportBreakdown,
  type ReportPeriod,
} from '../internal/custom-reports.js';
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
export {
  TodayService,
  yesterdayIn,
  type OrderDay,
  type OrderToday,
} from '../internal/today.service.js';
export {
  OrderTrackingService,
  type TrackingForm,
  type TrackingView,
} from '../internal/tracking.service.js';
export {
  COURIER_PERFORMANCE_LIMITS,
  CourierPerformanceService,
  deliveryRatesIn,
  type DeliveryRateRow,
  type CourierPerformanceRow,
} from '../internal/courier-performance.service.js';
export {
  ESTIMATED_CHARGE,
  estimateParcelChargesIn,
  type ParcelChargeEstimate,
} from '../internal/parcel-estimates.js';
export { OrdersModule } from '../internal/orders.module.js';
export {
  Fulfillment,
  MailingAddress,
  Order,
  OrderAgreement,
  OrderBulkPayload,
  OrderEvent,
} from '../internal/graphql/order.types.js';
export { DocumentLanguage, PaperSize } from '../internal/graphql/document.types.js';
export { SalesInterval } from '../internal/graphql/sales-report.types.js';
export { hidesPhones, toAddress, toOrder } from '../internal/graphql/mappers.js';
export { deliverySlotText } from '../internal/delivery-slot.js';
export {
  NO_ORDERS,
  type CustomerOrderStats,
  type DeliverySlotValue,
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
  type RefundReceiptRecord,
  type RefundRecord,
  type ReturnRecord,
} from '../internal/records.js';
export { RiskSettingsService, type RiskSettingsInput } from '../internal/risk-settings.service.js';
export {
  CONFIRMATION_CALL,
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
export {
  SUBSCRIPTION_LIMITS,
  SUBSCRIPTION_PROPERTY,
  SubscriptionService,
  changeSubscriptionIn,
  nextOrderDay,
  subscriptionOfOrderIn,
  type SubscriptionRecord,
  type SubscriptionStatus,
} from '../internal/subscriptions.js';
export {
  POS_LIMITS,
  POS_TENDER_METHODS,
  PosService,
  type PosRegisterRecord,
  type PosSaleRecord,
  type PosSessionReport,
  type PosTenderMethod,
} from '../internal/pos.service.js';
