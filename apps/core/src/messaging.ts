import {
  PhoneCodeSender,
  type PhoneCodeChannel,
  type PhoneCodeLanguage,
} from '@hatti/identity/public';
import { newId } from '@hatti/ids';
import type { Logger } from '@hatti/logger';
import {
  LogProvider,
  SmsGatewayProvider,
  WhatsAppCloudProvider,
  type MessageChannel,
  type MessageProvider,
  type OutgoingMessage,
  type SendResult,
} from '@hatti/messaging/public';
import type { MessageSendingConfig } from './config.js';
import { SesMessageEmails } from './emails.js';

/**
 * How each channel sends (ADR-146): Hatti's WhatsApp number, the SMS gateway and Amazon SES, for
 * orders' emails (ADR-181), where they are set up; elsewhere the log, in development, and nothing
 * in production, where messages fail as unsent.
 */
export function messageProvidersOf(
  config: MessageSendingConfig,
  logger: Logger,
): Partial<Record<MessageChannel, MessageProvider>> {
  const log = (channel: MessageChannel) =>
    new LogProvider(channel, (message, text) =>
      logger.info({ messageId: message.id, kind: message.kind, channel }, `not sent: ${text}`),
    );
  const providers: Partial<Record<MessageChannel, MessageProvider>> = {};
  if (config.WHATSAPP_PHONE_NUMBER_ID && config.WHATSAPP_ACCESS_TOKEN) {
    providers.whatsapp = new WhatsAppCloudProvider({
      baseUrl: config.META_GRAPH_URL,
      version: config.META_GRAPH_VERSION,
      phoneNumberId: config.WHATSAPP_PHONE_NUMBER_ID,
      accessToken: config.WHATSAPP_ACCESS_TOKEN,
    });
  } else if (config.NODE_ENV !== 'production') {
    providers.whatsapp = log('whatsapp');
  }
  if (config.SMS_GATEWAY_URL && config.SMS_GATEWAY_KEY) {
    providers.sms = new SmsGatewayProvider({
      url: config.SMS_GATEWAY_URL,
      apiKey: config.SMS_GATEWAY_KEY,
      sender: config.SMS_SENDER,
    });
  } else if (config.NODE_ENV !== 'production') {
    providers.sms = log('sms');
  }
  if (config.SES_REGION && config.SES_ACCESS_KEY_ID && config.SES_SECRET_ACCESS_KEY) {
    providers.email = new SesMessageEmails({
      region: config.SES_REGION,
      accessKeyId: config.SES_ACCESS_KEY_ID,
      secretAccessKey: config.SES_SECRET_ACCESS_KEY,
      from: config.EMAIL_FROM,
      baseUrl: config.SES_URL,
    });
  } else if (config.NODE_ENV !== 'production') {
    providers.email = log('email');
  }
  return providers;
}

/**
 * Sends the codes merchants sign in with (ADR-159) at once, through Hatti's own number and SMS
 * gateway: on the channel asked for, and on the other when that one cannot deliver it. Never a
 * shop's message: nothing is queued, and no shop's credit pays.
 */
export class ProviderPhoneCodes extends PhoneCodeSender {
  constructor(
    private readonly providers: Partial<Record<MessageChannel, MessageProvider>>,
    private readonly logger?: Pick<Logger, 'warn'>,
  ) {
    super();
  }

  async send(input: {
    phone: string;
    code: string;
    channel: PhoneCodeChannel;
    language: PhoneCodeLanguage;
  }): Promise<PhoneCodeChannel | null> {
    return this.#first(
      input.channel === 'sms' ? ['sms', 'whatsapp'] : ['whatsapp', 'sms'],
      {
        kind: 'sign_in_code',
        recipient: input.phone,
        language: input.language,
        variables: { shop: 'Hatti', code: input.code },
      },
      'sign-in code not sent',
    );
  }

  /** Tells a number another replaced (ADR-173): on WhatsApp, else by SMS. */
  override async tellReplaced(input: {
    phone: string;
    replacedBy: string;
    language: PhoneCodeLanguage;
  }): Promise<PhoneCodeChannel | null> {
    return this.#first(
      ['whatsapp', 'sms'],
      {
        kind: 'number_replaced',
        recipient: input.phone,
        language: input.language,
        variables: { shop: 'Hatti', phone: input.replacedBy },
      },
      'word of a number replaced not sent',
    );
  }

  /** Tells a number of a sign-in from a device new to its account (ADR-179): on WhatsApp, else by SMS. */
  override async tellSignedIn(input: {
    phone: string;
    device: string;
    date: string;
    language: PhoneCodeLanguage;
  }): Promise<PhoneCodeChannel | null> {
    return this.#first(
      ['whatsapp', 'sms'],
      {
        kind: 'sign_in_alert',
        recipient: input.phone,
        language: input.language,
        variables: { shop: 'Hatti', device: input.device, date: input.date },
      },
      'sign-in alert not sent',
    );
  }

  /**
   * Sends `message` on the first of `order`'s channels that takes it: which, or null. What a
   * channel refuses is logged as `failed`.
   */
  async #first(
    order: PhoneCodeChannel[],
    message: Omit<OutgoingMessage, 'id' | 'channel'>,
    failed: string,
  ): Promise<PhoneCodeChannel | null> {
    for (const channel of order) {
      const provider = this.providers[channel];
      if (!provider) continue;
      const result: SendResult = await provider
        .send({ ...message, id: newId(), channel })
        .catch((error: unknown) => ({ ok: false, outcome: 'retry', error: String(error) }));
      if (result.ok) return channel;
      this.logger?.warn({ channel, error: result.error }, failed);
    }
    return null;
  }
}
