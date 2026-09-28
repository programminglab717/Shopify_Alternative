// The customers module's public surface. Everything under src/internal is private to this module.
export {
  BlocklistService,
  type BlocklistAddInput,
  type ListBlocklistOptions,
} from '../internal/blocklist.service.js';
export {
  CustomerService,
  type CustomerCreateInput,
  type CustomerUpdateInput,
  type ListCustomersOptions,
  type OrderCustomerDetails,
} from '../internal/customer.service.js';
export { CustomersModule } from '../internal/customers.module.js';
export {
  CustomerEvents,
  type BlocklistEntryCreatedPayload,
  type BlocklistEntryDeletedPayload,
  type BlocklistEntryUpdatedPayload,
  type CustomerCreatedPayload,
  type CustomerUpdatedPayload,
} from '../internal/events.js';
// The GraphQL customer type and its mapper, for other modules' fields that return a customer or
// add to one.
export { Customer } from '../internal/graphql/customer.types.js';
export { toCustomer } from '../internal/graphql/mappers.js';
export type { BlocklistEntryRecord, CustomerRecord } from '../internal/records.js';
export { blockReasonText, displayPhone } from '../internal/rules.js';
export { BLOCK_REASONS, type BlockReasonValue } from '../internal/schema.js';
