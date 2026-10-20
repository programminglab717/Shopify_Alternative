import { createHmac, timingSafeEqual } from 'node:crypto';

// What the voice gateway says became of a call it placed (COD-03, ADR-611): answered or not, and
// the key pressed on it, if any, posted to Hatti's webhook signed with the secret the two share.

/** What the webhook checks the gateway's requests with: the secret it signs them with. */
export interface VoiceWebhookSettings {
  secret: string;
}

export const VOICE_WEBHOOK = Symbol('VOICE_WEBHOOK');

export const CALL_RESULTS = ['answered', 'no_answer', 'busy', 'failed'] as const;
export type CallResultValue = (typeof CALL_RESULTS)[number];

/** A call's end, as the gateway tells it. */
export interface CallResult {
  /** The gateway's ID for the call, as it gave it when the call was asked for. */
  callId: string;
  result: CallResultValue;
  /** The key pressed, "1"; null for none. */
  key: string | null;
  at: Date;
}

/** Whether `header`, "sha256=<hex>", is the HMAC-SHA256 of the request's raw body by `secret`. */
export function voiceSignatureValid(
  rawBody: Buffer,
  header: string | undefined,
  secret: string,
): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  const given = Buffer.from(header.slice('sha256='.length), 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * The call's end in a request's body: `{ id, result, key?, at? }`, `id` the gateway's for the call,
 * or `reference`, Hatti's, where it gave none; `at` an ISO time, now without one. Null for a body
 * that says none.
 */
export function parseCallResult(body: unknown, now: Date = new Date()): CallResult | null {
  if (typeof body !== 'object' || body === null) return null;
  const { result, key, at, reference } = body as Record<string, unknown>;
  const id = (body as Record<string, unknown>).id ?? reference;
  if (typeof id !== 'string' && typeof id !== 'number') return null;
  if (typeof result !== 'string' || !(CALL_RESULTS as readonly string[]).includes(result)) {
    return null;
  }
  const when = typeof at === 'string' ? new Date(at) : now;
  return {
    callId: String(id).slice(0, 200),
    result: result as CallResultValue,
    // A single key, as the call listens for.
    key: typeof key === 'string' && /^[0-9*#]$/.test(key) ? key : null,
    at: Number.isNaN(when.getTime()) ? now : when,
  };
}
