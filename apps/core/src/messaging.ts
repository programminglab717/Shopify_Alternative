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
  type SendResult,
} from '@hatti/messaging/public';
import type { MessageSendingConfig } from './config.js';

/**
 * How each channel sends (ADR-146): Hatti's WhatsApp number and the SMS gateway where they are
 * set up; elsewhere the log, in development, and nothing in production, where messages fail as
 * unsent.
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
    const order: PhoneCodeChannel[] =
      input.channel === 'sms' ? ['sms', 'whatsapp'] : ['whatsapp', 'sms'];
    for (const channel of order) {
      const provider = this.providers[channel];
      if (!provider) continue;
      const result: SendResult = await provider
        .send({
          id: newId(),
          kind: 'sign_in_code',
          channel,
          recipient: input.phone,
          language: input.language,
          variables: { shop: 'Hatti', code: input.code },
        })
        .catch((error: unknown) => ({ ok: false, outcome: 'retry', error: String(error) }));
      if (result.ok) return channel;
      this.logger?.warn({ channel, error: result.error }, 'sign-in code not sent');
    }
    return null;
  }
}
