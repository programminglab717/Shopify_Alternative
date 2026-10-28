import { createHmac, timingSafeEqual } from 'node:crypto';

// Webhooks from Hatti (ADR-397): each delivery is signed with the app's webhook secret, its raw
// body's HMAC-SHA256 in base64 in `x-hatti-hmac-sha256`. An app checks it before trusting a word.

/** The headers a delivery comes with, as Hatti sends them. */
export const WEBHOOK_HEADERS = {
  topic: 'x-hatti-topic',
  shopId: 'x-hatti-shop-id',
  eventId: 'x-hatti-event-id',
  webhookId: 'x-hatti-webhook-id',
  triggeredAt: 'x-hatti-triggered-at',
  signature: 'x-hatti-hmac-sha256',
} as const;

/** Whether `signature` is the delivery's: `body` as it came, before any parsing. */
export function verifyWebhook(
  body: string | Buffer,
  signature: string | null | undefined,
  secret: string,
): boolean {
  if (!signature || !secret) return false;
  const expected = createHmac('sha256', secret).update(body).digest();
  let given: Buffer;
  try {
    given = Buffer.from(signature, 'base64');
  } catch {
    return false;
  }
  return given.length === expected.length && timingSafeEqual(given, expected);
}
