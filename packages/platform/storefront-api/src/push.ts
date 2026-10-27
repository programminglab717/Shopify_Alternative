// Pushes to shoppers (OS-14, ADR-833): a shopper turns on notifications from the shop's online
// store, and the storefront passes their browser's subscription on to the core, which keeps it
// for the shop's push campaigns.

import { STOREFRONT_API_PREFIX } from './cart.js';

/**
 * POST a {@link PushSubscribeRequest}: kept, answered 204; 422, with a
 * {@link PushSubscribeErrorResponse}, says what was wrong with it; 404 while Hatti pushes nothing.
 */
export function pushSubscriptionsPath(shopId: string): string {
  return `${STOREFRONT_API_PREFIX}shops/${shopId}/push-subscriptions`;
}

/** POST a {@link PushUnsubscribeRequest}: forgotten, answered 204, whether it was kept or not. */
export function pushUnsubscribePath(shopId: string): string {
  return `${pushSubscriptionsPath(shopId)}/remove`;
}

/** A browser's subscription, as PushSubscription.toJSON() gives it, and its page's language. */
export interface PushSubscribeRequest {
  endpoint: string;
  /** The browser's P-256 public key, base64url. */
  p256dh: string;
  /** Its authentication secret, base64url. */
  auth: string;
  locale: 'en' | 'ur';
}

export interface PushUnsubscribeRequest {
  endpoint: string;
}

/** What was wrong with a subscription, by field: "endpoint", "keys". */
export interface PushSubscribeErrorResponse {
  errors: { field: string; message: string }[];
}
