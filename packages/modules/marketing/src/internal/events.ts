/**
 * Events the marketing module publishes. Payloads are thin: fetch current state through the API.
 */
export const MarketingEvents = {
  MetaConversionsUpdated: 'meta_conversions.updated',
  MetaConversionsDeleted: 'meta_conversions.deleted',
  TikTokEventsUpdated: 'tiktok_events.updated',
  TikTokEventsDeleted: 'tiktok_events.deleted',
  GoogleAnalyticsUpdated: 'google_analytics.updated',
  GoogleAnalyticsDeleted: 'google_analytics.deleted',
  MetaAdAccountConnected: 'meta_ad_account.connected',
  MetaAdAccountDisconnected: 'meta_ad_account.disconnected',
  TikTokAdAccountConnected: 'tiktok_ad_account.connected',
  TikTokAdAccountDisconnected: 'tiktok_ad_account.disconnected',
  GoogleAdsAccountConnected: 'google_ads_account.connected',
  GoogleAdsAccountDisconnected: 'google_ads_account.disconnected',
} as const;

/** The shop connected its Meta dataset, or changed how its orders go to it. */
export interface MetaConversionsUpdatedPayload {
  /** What changed: "pixelId", "accessToken", "testEventCode" or "purchaseAt". */
  changed: string[];
  actorKind: 'app' | 'staff';
  actorId: string;
}

/** The shop disconnected its Meta dataset: its orders go to Meta no more. */
export interface MetaConversionsDeletedPayload {
  pixelId: string;
  actorKind: 'app' | 'staff';
  actorId: string;
}

/** The shop connected its TikTok pixel, or changed how its orders go to it (ADR-541). */
export interface TikTokEventsUpdatedPayload {
  /** What changed: "pixelCode", "accessToken", "testEventCode" or "purchaseAt". */
  changed: string[];
  actorKind: 'app' | 'staff';
  actorId: string;
}

/** The shop disconnected its TikTok pixel: its orders go to TikTok no more. */
export interface TikTokEventsDeletedPayload {
  pixelCode: string;
  actorKind: 'app' | 'staff';
  actorId: string;
}

/** The shop connected its Google Analytics stream, or changed how its orders go to it (ADR-547). */
export interface GoogleAnalyticsUpdatedPayload {
  /** What changed: "measurementId", "apiSecret" or "purchaseAt". */
  changed: string[];
  actorKind: 'app' | 'staff';
  actorId: string;
}

/** The shop disconnected its Google Analytics stream: its orders go to Google no more. */
export interface GoogleAnalyticsDeletedPayload {
  measurementId: string;
  actorKind: 'app' | 'staff';
  actorId: string;
}

/**
 * The shop connected its Meta ad account, whose spend is pulled from Meta from then on, or gave
 * it another token (ADR-564).
 */
export interface MetaAdAccountConnectedPayload {
  adAccountId: string;
  /** What changed: "adAccountId", "accessToken". */
  changed: string[];
  actorKind: 'app' | 'staff';
  actorId: string;
}

/** The shop disconnected its Meta ad account: the spend pulled stays, and no more is pulled. */
export interface MetaAdAccountDisconnectedPayload {
  adAccountId: string;
  actorKind: 'app' | 'staff';
  actorId: string;
}

/**
 * The shop connected its TikTok advertiser account, whose spend is pulled from TikTok from then
 * on, or gave it another token (ADR-566).
 */
export interface TikTokAdAccountConnectedPayload {
  advertiserId: string;
  /** What changed: "advertiserId", "accessToken". */
  changed: string[];
  actorKind: 'app' | 'staff';
  actorId: string;
}

/** The shop disconnected its TikTok advertiser account: the spend pulled stays, and no more is. */
export interface TikTokAdAccountDisconnectedPayload {
  advertiserId: string;
  actorKind: 'app' | 'staff';
  actorId: string;
}

/**
 * The shop connected its Google Ads account, whose spend is pulled from Google from then on, or
 * gave it another grant (ADR-678).
 */
export interface GoogleAdsAccountConnectedPayload {
  customerId: string;
  /** What changed: "customerId", "accessToken". */
  changed: string[];
  actorKind: 'app' | 'staff';
  actorId: string;
}

/** The shop disconnected its Google Ads account: the spend pulled stays, and no more is. */
export interface GoogleAdsAccountDisconnectedPayload {
  customerId: string;
  actorKind: 'app' | 'staff';
  actorId: string;
}
