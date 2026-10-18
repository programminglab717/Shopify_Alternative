// The marketing module's public surface. Everything under src/internal is private to this module.
export {
  AD_SPEND_LIMITS,
  AD_SPEND_PLATFORMS,
  AD_SPEND_SOURCES,
  AdSpendService,
  adSpendByCampaignIn,
  adSpendByPeriodIn,
  type AdSpendEntry,
  type AdSpendInput,
  type AdSpendPeriod,
  type AdSpendPlatformValue,
  type AdSpendSourceValue,
} from '../internal/ad-spend.service.js';
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
  type MetaAdAccountConnectedPayload,
  type MetaAdAccountDisconnectedPayload,
  type TikTokAdAccountConnectedPayload,
  type TikTokAdAccountDisconnectedPayload,
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
  googleMeasurementIdIn,
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
  META_AD_SPEND_DAYS,
  META_AD_SPEND_PULL_GAP_MS,
  MetaAdAccountService,
  type MetaAdAccountInput,
  type MetaAdAccountRecord,
  type MetaAdSpendPull,
} from '../internal/meta-ad-account.service.js';
export {
  META_INSIGHTS_PAGES,
  MetaAdsClient,
  adAccountIdOf,
  spendMinor,
  type MetaAdAccountFacts,
  type MetaAdsResult,
  type MetaCampaignDay,
} from '../internal/meta-ad-spend.js';
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
  TikTokAdAccountService,
  type TikTokAdAccountInput,
  type TikTokAdAccountRecord,
  type TikTokAdSpendPull,
} from '../internal/tiktok-ad-account.service.js';
export {
  TIKTOK_REPORT_PAGES,
  TikTokAdsClient,
  advertiserIdOf,
  type TikTokAdsResult,
  type TikTokAdvertiserFacts,
  type TikTokCampaignDay,
} from '../internal/tiktok-ad-spend.js';
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
