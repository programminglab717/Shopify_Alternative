// The inventory module's public surface. Everything under src/internal is private to this module.
export {
  InventoryEvents,
  type InventoryItemUpdatedPayload,
  type InventoryLevelUpdatedPayload,
  type LocationCreatedPayload,
  type LocationDeletedPayload,
  type LocationUpdatedPayload,
} from '../internal/events.js';
// The GraphQL location type and its mapper, for other modules' fields that return a location.
export { Location } from '../internal/graphql/location.types.js';
export { toLocation } from '../internal/graphql/mappers.js';
export { InventoryModule } from '../internal/inventory.module.js';
export {
  LOW_STOCK_THRESHOLD,
  LowStockService,
  inventorySettingsIn,
  type InventorySettingsInput,
  type InventorySettingsRecord,
  type LowStockCounts,
  type LowStockRecord,
} from '../internal/low-stock.service.js';
export {
  InventoryService,
  type AdjustQuantitiesInput,
  type HistoryOptions,
  type InventoryChangeInput,
  type InventoryItemUpdateInput,
  type InventoryQuantityInput,
  type SetQuantitiesInput,
} from '../internal/inventory.service.js';
export { availableForSale, sellableQuantity } from '../internal/item-store.js';
export {
  LocationService,
  type ListLocationsOptions,
  type LocationAddInput,
  type LocationAddressInput,
  type LocationEditInput,
} from '../internal/location.service.js';
export type {
  AdjustmentGroupRecord,
  InventoryChangeRecord,
  InventoryItemRecord,
  InventoryLevelRecord,
  LocationAddressRecord,
  LocationRecord,
  Quantities,
} from '../internal/records.js';
export {
  ADJUSTMENT_REASONS,
  FIRST_LOCATION_NAME,
  SETTABLE_NAMES,
  STOCK_REASONS,
  type AdjustmentReason,
  type SettableName,
} from '../internal/rules.js';
export type { InventoryPolicyValue, QuantityName } from '../internal/schema.js';
export {
  StockService,
  type StockCaller,
  type StockLine,
  type StockOptions,
  type StockResult,
  type StockShortage,
} from '../internal/stock.service.js';
