// The marketing module's public surface. Everything under src/internal is private to this module.
export {
  ConversionsService,
  type ClaimedConversion,
  type ConversionOutcome,
  type ConversionRecord,
} from '../internal/conversions.service.js';
export {
  CALENDAR_DAYS_MAX,
  MARKETING_MOMENTS,
  marketingCalendar,
  marketingDatesOf,
  type CampaignKit,
  type MarketingDate,
  type MarketingMomentValue,
} from '../internal/calendar.js';
export { MarketingCalendarService } from '../internal/calendar.service.js';
export {
  MarketingEvents,
  type MetaConversionsDeletedPayload,
  type MetaConversionsUpdatedPayload,
  type GoogleAnalyticsDeletedPayload,
  type GoogleAnalyticsUpdatedPayload,
  type TikTokEventsDeletedPayload,
  type TikTokEventsUpdatedPayload,
} from '../internal/events.js';
export {
  GoogleAnalyticsClient,
  type GoogleAnalyticsOptions,
  type GoogleSendResult,
  type GoogleStream,
} from '../internal/google-client.js';
export {
  GOOGLE_LIMITS,
  GoogleAnalyticsService,
  type GoogleAnalyticsInput,
  type GoogleAnalyticsRecord,
  type GoogleStreamSettings,
} from '../internal/google-settings.service.js';
export {
  GOOGLE_EVENT_WINDOW_MS,
  googleClientId,
  googleEvent,
  googleEventName,
  googleUserData,
  type GoogleEventsPayload,
} from '../internal/google.js';
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
  CONVERSION_PLATFORMS,
  CONVERSION_STATUSES,
  META_EVENT_WINDOW_MS,
  clickOf,
  metaEvent,
  metaEventName,
  metaUserData,
  retryDelayMs,
  type ConversionMomentValue,
  type ConversionOrder,
  type ConversionPlatformValue,
  type ConversionStatusValue,
  type MetaServerEvent,
} from '../internal/meta.js';
export {
  TikTokEventsClient,
  type TikTokApiOptions,
  type TikTokPixel,
  type TikTokSendResult,
} from '../internal/tiktok-client.js';
export {
  TIKTOK_LIMITS,
  TikTokEventsService,
  tiktokPixelCodeIn,
  type TikTokEventsInput,
  type TikTokEventsRecord,
  type TikTokPixelSettings,
} from '../internal/tiktok-settings.service.js';
export {
  tiktokClickOf,
  tiktokEvent,
  tiktokEventName,
  tiktokUser,
  type TikTokEvent,
  type TikTokUser,
} from '../internal/tiktok.js';
