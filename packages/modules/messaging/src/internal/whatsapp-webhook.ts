import { createHmac, timingSafeEqual } from 'node:crypto';
import type { StatusUpdate } from './messages.service.js';

// What WhatsApp's Cloud API tells Hatti's webhook (ADR-146): how the messages it was sent went,
// and what customers wrote back to the shared notifications number. Meta signs each request
// with the app's secret, in X-Hub-Signature-256.

/** A message a customer sent the notifications number. */
export interface InboundMessage {
  /** In E.164. */
  from: string;
  /** What they wrote, or the button they pressed: null for anything else, as a photo. */
  text: string | null;
  /** The ID of the message they replied to, or whose button they pressed. */
  replyTo: string | null;
  /** The payload of the button they pressed: "confirm". */
  payload: string | null;
  at: Date;
  /** WhatsApp's ID for it, which a webhook delivered twice names again (ADR-545). */
  id: string | null;
  /** The ID of the number it was written to: Hatti's shared one, or a shop's own. */
  to: string | null;
  /** What else it held, as WhatsApp names it: "image", "audio"; null for words and buttons. */
  mediaKind: string | null;
  /** WhatsApp's ID for what else it held, to fetch it by (ADR-871): a voice note's audio. */
  mediaId?: string | null;
  /**
   * A cart from the shop's WhatsApp catalogue (CH-02, ADR-856): each item as the catalogue names
   * it, the variant's ID from the catalog feed, and how many; absent for any other message.
   */
  cart?: { variantId: string; quantity: number }[] | null;
}

/** Meta's word of a shop's template (ADR-420): approved, rejected, paused or disabled. */
export interface TemplateStatusUpdate {
  /** Meta's ID for the template. */
  metaTemplateId: string;
  /** As Meta names it: "APPROVED". */
  event: string;
  /** Why Meta rejected, paused or disabled it, where it says. */
  reason: string | null;
}

export interface WhatsAppWebhook {
  statuses: StatusUpdate[];
  inbound: InboundMessage[];
  templates: TemplateStatusUpdate[];
}

/** Whether the request's body is the one Meta signed with the app's secret. */
export function signatureValid(
  rawBody: Buffer,
  header: string | undefined,
  appSecret: string,
): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  const given = Buffer.from(header.slice('sha256='.length), 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const STATUSES = new Set(['sent', 'delivered', 'read', 'failed']);

/** WhatsApp's kinds of media a message holds, each with the ID it is fetched by. */
const MEDIA = new Set(['audio', 'image', 'video', 'document', 'sticker']);

/** The statuses and messages in a webhook's body; anything else in it is left out. */
export function parseWhatsAppWebhook(body: unknown): WhatsAppWebhook {
  const statuses: StatusUpdate[] = [];
  const inbound: InboundMessage[] = [];
  const templates: TemplateStatusUpdate[] = [];
  for (const entry of arrayOf(field(body, 'entry'))) {
    for (const change of arrayOf(field(entry, 'changes'))) {
      const value = field(change, 'value');
      const to = field(field(value, 'metadata'), 'phone_number_id');
      if (field(change, 'field') === 'message_template_status_update') {
        const id = field(value, 'message_template_id');
        const event = field(value, 'event');
        const reason = field(value, 'reason');
        if ((typeof id === 'string' || typeof id === 'number') && typeof event === 'string') {
          templates.push({
            metaTemplateId: String(id).slice(0, 30),
            event: event.slice(0, 50),
            reason: typeof reason === 'string' && reason !== 'NONE' ? reason.slice(0, 500) : null,
          });
        }
        continue;
      }
      if (field(change, 'field') !== 'messages') continue;
      for (const status of arrayOf(field(value, 'statuses'))) {
        const id = field(status, 'id');
        const kind = field(status, 'status');
        if (typeof id !== 'string' || typeof kind !== 'string' || !STATUSES.has(kind)) continue;
        const [error] = arrayOf(field(status, 'errors'));
        const code = field(error, 'code');
        const title = field(error, 'title') ?? field(error, 'message');
        statuses.push({
          providerMessageId: id,
          status: kind as StatusUpdate['status'],
          at: timeOf(field(status, 'timestamp')),
          error: error
            ? `WhatsApp ${String(code ?? '')}: ${String(title ?? 'not delivered')}`
            : null,
        });
      }
      for (const message of arrayOf(field(value, 'messages'))) {
        const from = field(message, 'from');
        if (typeof from !== 'string' || !/^[1-9][0-9]{6,14}$/.test(from)) continue;
        const text =
          field(field(message, 'text'), 'body') ??
          field(field(message, 'button'), 'text') ??
          field(field(field(message, 'interactive'), 'button_reply'), 'title') ??
          // A cart's note, as the customer wrote it beside it.
          field(field(message, 'order'), 'text');
        const replyTo = field(field(message, 'context'), 'id');
        const payload =
          field(field(message, 'button'), 'payload') ??
          field(field(field(message, 'interactive'), 'button_reply'), 'id');
        const type = field(message, 'type');
        const id = field(message, 'id');
        const mediaId = typeof type === 'string' ? field(field(message, type), 'id') : undefined;
        inbound.push({
          from: `+${from}`,
          text: typeof text === 'string' ? text.slice(0, 4096) : null,
          replyTo: typeof replyTo === 'string' ? replyTo.slice(0, 200) : null,
          payload: typeof payload === 'string' ? payload.slice(0, 100) : null,
          at: timeOf(field(message, 'timestamp')),
          id: typeof id === 'string' ? id.slice(0, 200) : null,
          to: typeof to === 'string' && /^[0-9]{1,30}$/.test(to) ? to : null,
          mediaKind:
            typeof type === 'string' &&
            !['text', 'button', 'interactive'].includes(type) &&
            /^[a-z_]{1,30}$/.test(type)
              ? type
              : null,
          ...(MEDIA.has(String(type)) &&
            typeof mediaId === 'string' &&
            /^[0-9A-Za-z_-]{1,200}$/.test(mediaId) && { mediaId }),
          ...(type === 'order' && { cart: cartOf(field(message, 'order')) }),
        });
      }
    }
  }
  return { statuses, inbound, templates };
}

/** A catalogue order's items, each named and of 1 to 999; null for none worth keeping. */
function cartOf(order: unknown): { variantId: string; quantity: number }[] | null {
  const items: { variantId: string; quantity: number }[] = [];
  for (const item of arrayOf(field(order, 'product_items')).slice(0, 50)) {
    const id = field(item, 'product_retailer_id');
    const quantity = Number(field(item, 'quantity'));
    if (typeof id !== 'string' || !/^[0-9A-Za-z_-]{1,100}$/.test(id)) continue;
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 999) continue;
    items.push({ variantId: id, quantity });
  }
  return items.length > 0 ? items : null;
}

function field(value: unknown, name: string): unknown {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)[name]
    : undefined;
}

function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** A Unix time in seconds, as WhatsApp gives it, as a string; now for anything else. */
function timeOf(value: unknown): Date {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : new Date();
}
