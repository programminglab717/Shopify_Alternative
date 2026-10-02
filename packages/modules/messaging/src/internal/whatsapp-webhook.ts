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
}

export interface WhatsAppWebhook {
  statuses: StatusUpdate[];
  inbound: InboundMessage[];
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

/** The statuses and messages in a webhook's body; anything else in it is left out. */
export function parseWhatsAppWebhook(body: unknown): WhatsAppWebhook {
  const statuses: StatusUpdate[] = [];
  const inbound: InboundMessage[] = [];
  for (const entry of arrayOf(field(body, 'entry'))) {
    for (const change of arrayOf(field(entry, 'changes'))) {
      if (field(change, 'field') !== 'messages') continue;
      const value = field(change, 'value');
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
          field(field(field(message, 'interactive'), 'button_reply'), 'title');
        const replyTo = field(field(message, 'context'), 'id');
        const payload =
          field(field(message, 'button'), 'payload') ??
          field(field(field(message, 'interactive'), 'button_reply'), 'id');
        inbound.push({
          from: `+${from}`,
          text: typeof text === 'string' ? text.slice(0, 4096) : null,
          replyTo: typeof replyTo === 'string' ? replyTo.slice(0, 200) : null,
          payload: typeof payload === 'string' ? payload.slice(0, 100) : null,
          at: timeOf(field(message, 'timestamp')),
        });
      }
    }
  }
  return { statuses, inbound };
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
