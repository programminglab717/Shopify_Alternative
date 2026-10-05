// The customers module's public surface. Everything under src/internal is private to this module.
export {
  BlocklistService,
  type BlocklistAddInput,
  type ListBlocklistOptions,
} from '../internal/blocklist.service.js';
export {
  CONSENT_LIMITS,
  recordCheckoutConsentIn,
  type MarketingConsentInput,
} from '../internal/consent.js';
export { marketingWording, marketingWords } from '../internal/consent-words.js';
export {
  CustomerDataRegistry,
  type CustomerDataHandler,
  type CustomerIdentity,
} from '../internal/customer-data.js';
export {
  CUSTOMER_DATA_FORMAT,
  CustomerDataService,
  type CustomerDataExport,
  type WaitingErasureRecord,
} from '../internal/customer-data.service.js';
export {
  CustomerService,
  type CustomerCreateInput,
  type CustomerUpdateInput,
  type ListCustomersOptions,
  type OrderCustomerDetails,
} from '../internal/customer.service.js';
export {
  CustomerTransferService,
  TRANSFER_LIMITS,
  type CustomerExportFilter,
  type CustomerImportOptions,
  type CustomerImportResult,
  type CustomerImportRowError,
} from '../internal/customer-transfer.service.js';
export { CustomersModule } from '../internal/customers.module.js';
export {
  CustomerEvents,
  type BlocklistEntryCreatedPayload,
  type BlocklistEntryDeletedPayload,
  type BlocklistEntryUpdatedPayload,
  type CustomerCreatedPayload,
  type CustomerErasedPayload,
  type CustomerExportCreatedPayload,
  type CustomerImportCreatedPayload,
  type CustomerMergedPayload,
  type CustomerUpdatedPayload,
  type StoreCreditCreditedPayload,
  type StoreCreditExpiringPayload,
  type MarketingConsentUpdatedPayload,
  type SegmentCreatedPayload,
  type SegmentDeletedPayload,
  type SegmentUpdatedPayload,
} from '../internal/events.js';
// The GraphQL customer type and its mapper, for other modules' fields that return a customer or
// add to one.
export {
  Customer,
  MarketingChannel as MarketingChannelEnum,
} from '../internal/graphql/customer.types.js';
export { toCustomer } from '../internal/graphql/mappers.js';
export type {
  BlocklistEntryRecord,
  ConsentEventRecord,
  CustomerRecord,
  MarketingConsentRecord,
  SegmentRecord,
} from '../internal/records.js';
export { SEGMENT_TIME_ZONE, blockReasonText, displayPhone } from '../internal/rules.js';
export {
  STORE_CREDIT_EVENTS,
  STORE_CREDIT_KINDS,
  STORE_CREDIT_LIMITS,
  STORE_CREDIT_REMINDER_MS,
  StoreCreditService,
  debitStoreCreditIn,
  revertOrderStoreCreditIn,
  shopGivesStoreCreditIn,
  storeCreditAccountsIn,
  storeCreditOfPhoneIn,
  storeCreditNoticeFactsIn,
  storeCreditPaidIn,
  type StoreCreditAccountRecord,
  type StoreCreditNoticeFacts,
  type StoreCreditChange,
  type StoreCreditEventValue,
  type StoreCreditGrant,
  type StoreCreditInput,
  type StoreCreditKindValue,
  type StoreCreditOwner,
  type StoreCreditTransactionRecord,
} from '../internal/store-credit.service.js';
export {
  BLOCK_REASONS,
  CONSENT_SOURCES,
  MARKETING_CHANNELS,
  MARKETING_STATES,
  type BlockReasonValue,
  type ConsentSourceValue,
  type MarketingChannelValue,
  type MarketingStateValue,
} from '../internal/schema.js';
export {
  SEGMENT_FIELD_TYPES,
  SEGMENT_OPERATORS,
  SegmentFieldRegistry,
  type SegmentFactSource,
  type SegmentField,
  type SegmentFieldType,
} from '../internal/segment-fields.js';
export { SignUpService, type SignUpInput, type SignUpOutcome } from '../internal/sign-ups.js';
export {
  SEGMENT_QUERY_LIMITS,
  SegmentQueryError,
  parseSegmentQuery,
} from '../internal/segment-query.js';
export {
  SegmentService,
  type SegmentCreateInput,
  type SegmentMembersOptions,
  type SegmentUpdateInput,
} from '../internal/segment.service.js';
