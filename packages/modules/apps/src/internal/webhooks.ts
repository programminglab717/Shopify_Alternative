import { createHmac } from 'node:crypto';
import type { DomainEvent } from '@hatti/events';
import { toPublicId } from '@hatti/ids';

/**
 * The topics an app may subscribe to, as Shopify names them, each with what the app must be able
 * to read and the shop's events that make it (DEV-03, ADR-397). Every change to an order is an
 * `orders/updated`, as Shopify's is.
 */
export const WEBHOOK_TOPICS = {
  'orders/create': { reads: 'orders', events: ['order.created'] },
  'orders/updated': {
    reads: 'orders',
    events: [
      'order.updated',
      'order.confirmed',
      'order.cancelled',
      'order.paid',
      'order.refunded',
      'order.assigned',
    ],
  },
  'orders/cancelled': { reads: 'orders', events: ['order.cancelled'] },
  'orders/paid': { reads: 'orders', events: ['order.paid'] },
  'fulfillments/create': { reads: 'orders', events: ['fulfillment.created'] },
  'fulfillments/update': { reads: 'orders', events: ['fulfillment.updated'] },
  'products/create': { reads: 'products', events: ['product.created'] },
  'products/update': { reads: 'products', events: ['product.updated'] },
  'products/delete': { reads: 'products', events: ['product.deleted'] },
  'inventory_levels/update': { reads: 'inventory', events: ['inventory_level.updated'] },
  'customers/create': { reads: 'customers', events: ['customer.created'] },
  'customers/update': { reads: 'customers', events: ['customer.updated'] },
  'app/uninstalled': { reads: null, events: ['app.deleted'] },
} as const satisfies Record<string, { reads: string | null; events: readonly string[] }>;

export type WebhookTopic = keyof typeof WEBHOOK_TOPICS;

export const WEBHOOK_TOPIC_NAMES = Object.keys(WEBHOOK_TOPICS) as WebhookTopic[];

export function isWebhookTopic(value: string): value is WebhookTopic {
  return Object.hasOwn(WEBHOOK_TOPICS, value);
}

/** The shop's events webhooks are made from. */
export const WEBHOOK_EVENTS: readonly string[] = [
  ...new Set(Object.values(WEBHOOK_TOPICS).flatMap((topic) => topic.events)),
];

/** The topics an event makes. */
export function topicsOf(eventType: string): WebhookTopic[] {
  return WEBHOOK_TOPIC_NAMES.filter((topic) =>
    (WEBHOOK_TOPICS[topic].events as readonly string[]).includes(eventType),
  );
}

/** The scopes either of which lets an app subscribe to `topic`; none for the app's own. */
export function scopesFor(topic: WebhookTopic): string[] {
  const reads = WEBHOOK_TOPICS[topic].reads;
  return reads ? [`read_${reads}`, `write_${reads}`] : [];
}

/** How webhooks are kept and sent. */
export const WEBHOOK_LIMITS = {
  /** Subscriptions an app keeps at a time. */
  subscriptions: 50,
  uri: 2_000,
  /** How long an app has to answer. */
  timeoutMs: 5_000,
  /** How long a delivery is tried for, from when it was made. */
  triesForMs: 48 * 3_600_000,
  /** How long each delivery's outcome is kept. */
  keptDays: 30,
  /** Deliveries a sweep sends. */
  batch: 50,
} as const;

/**
 * How long after its `attempts`th failed try a delivery is tried again: a minute, then twice as
 * long each time, six hours at most; about sixteen tries in its two days.
 */
export function retryDelayMs(attempts: number): number {
  return Math.min(60_000 * 2 ** Math.max(0, attempts - 1), 6 * 3_600_000);
}

/** What a delivery says of the resource its event names: its ID, and a little more for some. */
function dataOf(event: DomainEvent): Record<string, unknown> | null {
  const payload = event.payload as Record<string, unknown>;
  switch (event.aggregateType) {
    case 'order':
      return { id: toPublicId('order', event.aggregateId) };
    case 'fulfillment':
      return {
        id: toPublicId('fulfillment', event.aggregateId),
        ...(typeof payload.orderId === 'string' && {
          order_id: toPublicId('order', payload.orderId),
        }),
        ...(typeof payload.status === 'string' && { status: payload.status }),
      };
    case 'product':
      return { id: toPublicId('product', event.aggregateId) };
    case 'customer':
      return { id: toPublicId('customer', event.aggregateId) };
    case 'inventory_level':
      if (typeof payload.inventoryItemId !== 'string' || typeof payload.locationId !== 'string') {
        return null;
      }
      return {
        inventory_item_id: toPublicId('inventoryItem', payload.inventoryItemId),
        location_id: toPublicId('location', payload.locationId),
        available: payload.available ?? null,
      };
    case 'app':
      return { id: toPublicId('accessToken', event.aggregateId) };
    default:
      return null;
  }
}

/**
 * What a delivery of `event` posts for `topic`: the topic, the event, when it happened and the
 * shop, and the resource by its ID, for the app to fetch through the Admin API. Null for an event
 * that names nothing a webhook tells of.
 */
export function webhookBody(
  topic: WebhookTopic,
  event: DomainEvent,
): Record<string, unknown> | null {
  const data = dataOf(event);
  if (!data) return null;
  return {
    topic,
    event_id: toPublicId('event', event.id),
    occurred_at: event.occurredAt,
    shop_id: toPublicId('shop', event.shopId),
    data,
  };
}

/** The signature an app checks a delivery by: the body's HMAC-SHA256 with its secret, in base64. */
export function signWebhook(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body, 'utf8').digest('base64');
}

/**
 * Why `value` cannot be where an app is sent its webhooks, if it cannot: an https address with
 * no password, not this host or an address on a private network. Where its name points is
 * checked again each time it is sent one.
 */
export function uriProblem(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'is not an address';
  }
  if (url.protocol !== 'https:') return 'must be an https address';
  if (url.username || url.password) return "can't have a user name or password";
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || !host.includes('.')) {
    return 'must be on the public internet';
  }
  return null;
}
