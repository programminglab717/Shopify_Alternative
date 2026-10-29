// The inventory module's public surface. Everything under src/internal is private to this module.
export {
  InventoryEvents,
  type InventoryItemUpdatedPayload,
  type InventoryLevelUpdatedPayload,
  type StockAlertedPayload,
  type InventoryTransferPayload,
  type LocationCreatedPayload,
  type LocationDeletedPayload,
  type LocationUpdatedPayload,
  type ProductPreorderUpdatedPayload,
  type PurchaseOrderPayload,
  type SupplierPayload,
} from '../internal/events.js';
// The GraphQL location type and its mapper, for other modules' fields that return a location.
export { Location } from '../internal/graphql/location.types.js';
export { toLocation } from '../internal/graphql/mappers.js';
// What copies a duplicated product's stock settings for the catalog (ADR-343), which the host binds.
export { InventoryCopiedVariantStock } from '../internal/copied-stock.js';
export { InventoryModule } from '../internal/inventory.module.js';
// Inventory reports (ADR-455), which custom reports of stock run (ADR-910).
export {
  INVENTORY_REPORT_LIMIT,
  InventoryReportService,
  type InventoryReportRecord,
  type InventoryReportRow,
} from '../internal/inventory-report.service.js';
export {
  LOW_STOCK_THRESHOLD,
  LowStockService,
  inventorySettingsIn,
  type InventorySettingsInput,
  type InventorySettingsRecord,
  type LowStockAlert,
  type LowStockCounts,
  type LowStockRecord,
} from '../internal/low-stock.service.js';
export {
  InventoryService,
  harmonizedSystemCodeOf,
  type AdjustQuantitiesInput,
  type HistoryOptions,
  type InventoryChangeInput,
  type InventoryItemUpdateInput,
  type InventoryQuantityInput,
  type SetQuantitiesInput,
} from '../internal/inventory.service.js';
export {
  availableForSale,
  fbrItemFieldsIn,
  harmonizedSystemCodesIn,
  type FbrItemFields,
  sellableQuantity,
} from '../internal/item-store.js';
// Pre-orders (CAT-14, ADR-403): the day each product on pre-order ships by, for orders' lines and
// the storefront's documents.
export {
  PREORDER_LIMITS,
  PreorderService,
  pakistanDay,
  preordersIn,
  type PreorderRecord,
} from '../internal/preorders.js';
// Transfers between locations (ADR-360), counted on the admin's home (ADR-364).
export { TransferService } from '../internal/transfer.service.js';
export {
  LocationService,
  SPLIT_MOST_LOCATIONS,
  pickupLocationsIn,
  storefrontLocationsIn,
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
  type RecommitResult,
  type StockCaller,
  type StockLine,
  type StockOptions,
  type StockResult,
  type StockShortage,
} from '../internal/stock.service.js';
