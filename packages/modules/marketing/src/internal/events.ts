/**
 * Events the marketing module publishes. Payloads are thin: fetch current state through the API.
 */
export const MarketingEvents = {
  MetaConversionsUpdated: 'meta_conversions.updated',
  MetaConversionsDeleted: 'meta_conversions.deleted',
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
