// The marketing module's public surface. Everything under src/internal is private to this module.
export {
  ConversionsService,
  type ClaimedConversion,
  type ConversionOutcome,
  type ConversionRecord,
} from '../internal/conversions.service.js';
export {
  MarketingEvents,
  type MetaConversionsDeletedPayload,
  type MetaConversionsUpdatedPayload,
} from '../internal/events.js';
export { MarketingModule } from '../internal/marketing.module.js';
export {
  MetaConversionsClient,
  type MetaDataset,
  type MetaGraphOptions,
  type MetaSendResult,
} from '../internal/meta-client.js';
export {
  META_LIMITS,
  MetaConversionsService,
  metaPixelIdIn,
  type MetaConversionsInput,
  type MetaConversionsRecord,
  type MetaDatasetSettings,
} from '../internal/meta-settings.service.js';
export {
  CONVERSION_MOMENTS,
  CONVERSION_STATUSES,
  META_EVENT_WINDOW_MS,
  clickOf,
  metaEvent,
  metaEventName,
  metaUserData,
  retryDelayMs,
  type ConversionMomentValue,
  type ConversionOrder,
  type ConversionStatusValue,
  type MetaServerEvent,
} from '../internal/meta.js';
