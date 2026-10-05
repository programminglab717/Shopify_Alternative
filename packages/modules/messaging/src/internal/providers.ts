import {
  messageEmail,
  messageText,
  templateButtons,
  templateParameters,
  TEMPLATES,
  type AnyMessageKind,
  type MessageLanguage,
  type MessageVariables,
} from './templates.js';

// The channels messages go by (ADR-146): WhatsApp's Cloud API from Hatti's shared notifications
// number (MSG-03), an SMS gateway, email for the news of orders (ADR-181), which the host
// application sends, and a log in place of any where none is set up, as in development. Each says
// what became of a message: sent, with the provider's ID for it; to be tried again; better sent
// another way; or never to be sent.

export const MESSAGE_CHANNELS = ['whatsapp', 'sms', 'email'] as const;
export type MessageChannel = (typeof MESSAGE_CHANNELS)[number];

/** The channels that reach a number: what a code, or a reply, goes by. */
export type PhoneChannel = Exclude<MessageChannel, 'email'>;

/** A message as a provider sends it. */
export interface OutgoingMessage {
  id: string;
  kind: AnyMessageKind;
  channel: MessageChannel;
  /** In E.164; an email's, the address, lowercased. */
  recipient: string;
  language: MessageLanguage;
  variables: MessageVariables;
}

export type SendResult =
  | { ok: true; providerMessageId: string }
  | {
      ok: false;
      /**
       * retry: later, as when the provider is busy; replace: this channel cannot deliver it, and
       * an SMS may; fail: nothing will.
       */
      outcome: 'retry' | 'replace' | 'fail';
      error: string;
    };

export interface MessageProvider {
  /** Kept with each message it sends, with its ID for it: "whatsapp_cloud". */
  readonly name: string;
  readonly channel: MessageChannel;
  send(message: OutgoingMessage): Promise<SendResult>;
}

/** What may be tried again of WhatsApp's errors: its limits, and its own trouble. */
const WHATSAPP_RETRY_CODES = new Set([
  1, 2, 4, 80007, 130429, 131000, 131016, 131048, 131056, 133004,
]);

/** The provider WhatsApp's Cloud API sends as: its webhook names messages by their IDs there. */
export const WHATSAPP_CLOUD = 'whatsapp_cloud';

/**
 * The provider Amazon SES sends shops' emails as (ADR-181): its notifications name each email by
 * the ID it gave it (ADR-197).
 */
export const SES_EMAIL = 'ses';

export interface WhatsAppCloudOptions {
  /** Meta's Graph API: https://graph.facebook.com. */
  baseUrl: string;
  /** "v26.0". */
  version: string;
  /** The ID of Hatti's notifications number with WhatsApp. */
  phoneNumberId: string;
  accessToken: string;
  timeoutMs?: number;
}

/**
 * Sends Hatti's approved templates from its shared notifications number through WhatsApp's Cloud
 * API. What WhatsApp refuses for good, an SMS may still carry.
 */
export class WhatsAppCloudProvider implements MessageProvider {
  readonly name = WHATSAPP_CLOUD;
  readonly channel = 'whatsapp' as const;

  constructor(private readonly options: WhatsAppCloudOptions) {}

  async send(message: OutgoingMessage): Promise<SendResult> {
    const { baseUrl, version, phoneNumberId, accessToken, timeoutMs } = this.options;
    const url = `${baseUrl.replace(/\/+$/, '')}/${version}/${phoneNumberId}/messages`;
    const template = TEMPLATES[message.kind];
    let response: Response;
    try {
      const parameters = templateParameters(message.kind, message.variables);
      response = await fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: message.recipient.slice(1),
          type: 'template',
          template: {
            name: template.whatsapp,
            language: { code: message.language },
            components: [
              // A template with no variables, as word of a number removed, takes no body's.
              ...(parameters.length > 0
                ? [{ type: 'body', parameters: parameters.map((text) => ({ type: 'text', text })) }]
                : []),
              ...templateButtons(message.kind, message.variables),
            ],
          },
        }),
        signal: AbortSignal.timeout(timeoutMs ?? 10_000),
      });
    } catch (error) {
      return { ok: false, outcome: 'retry', error: `WhatsApp not reached: ${errorText(error)}` };
    }
    const body = (await response.json().catch(() => ({}))) as {
      messages?: { id?: string }[];
      error?: { code?: number; message?: string; is_transient?: boolean };
    };
    const id = body.messages?.[0]?.id;
    if (response.ok && id) return { ok: true, providerMessageId: id };
    const code = body.error?.code;
    const retry =
      response.status >= 500 ||
      response.status === 429 ||
      body.error?.is_transient === true ||
      (code !== undefined && WHATSAPP_RETRY_CODES.has(code));
    return {
      ok: false,
      outcome: retry ? 'retry' : 'replace',
      error: clip(
        `WhatsApp ${code ?? response.status}: ${body.error?.message ?? 'no message ID returned'}`,
      ),
    };
  }
}

export interface SmsGatewayOptions {
  /** Where the gateway takes messages: a POST of `{ to, text, sender }` as JSON. */
  url: string;
  apiKey: string;
  /** The sender ID the gateway sends from: Hatti's shared one. */
  sender: string;
  timeoutMs?: number;
}

/**
 * Sends SMS through an aggregator's HTTP gateway (07 §3): the message's words, in English or Urdu,
 * to the number. It answers `{ id }`.
 */
export class SmsGatewayProvider implements MessageProvider {
  readonly name = 'sms_gateway';
  readonly channel = 'sms' as const;

  constructor(private readonly options: SmsGatewayOptions) {}

  async send(message: OutgoingMessage): Promise<SendResult> {
    const { url, apiKey, sender, timeoutMs } = this.options;
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          to: message.recipient,
          text: messageText(message.kind, message.language, message.variables),
          sender,
        }),
        signal: AbortSignal.timeout(timeoutMs ?? 10_000),
      });
    } catch (error) {
      return { ok: false, outcome: 'retry', error: `SMS gateway not reached: ${errorText(error)}` };
    }
    const body = (await response.json().catch(() => ({}))) as { id?: unknown; error?: unknown };
    if (response.ok) {
      // Taken: sending it again would send it twice, whatever the gateway said of it.
      const id = typeof body.id === 'string' || typeof body.id === 'number' ? body.id : null;
      return { ok: true, providerMessageId: id === null ? `sms-${message.id}` : String(id) };
    }
    const retry = response.status >= 500 || response.status === 429;
    return {
      ok: false,
      outcome: retry ? 'retry' : 'fail',
      error: clip(`SMS gateway ${response.status}: ${String(body.error ?? 'no reason given')}`),
    };
  }
}

/**
 * Sends nothing, telling `log` what it would have sent: where a channel is not set up, as in
 * development. Never in production.
 */
export class LogProvider implements MessageProvider {
  readonly name = 'log';

  constructor(
    readonly channel: MessageChannel,
    private readonly log: (message: OutgoingMessage, text: string) => void,
  ) {}

  async send(message: OutgoingMessage): Promise<SendResult> {
    const email =
      message.channel === 'email'
        ? messageEmail(message.kind, message.language, message.variables)
        : null;
    this.log(
      message,
      email
        ? `${email.subject}\n\n${email.text}`
        : messageText(message.kind, message.language, message.variables),
    );
    return { ok: true, providerMessageId: `log-${message.id}` };
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function clip(text: string): string {
  return text.slice(0, 1000);
}
