import { createLogger } from '@hatti/logger';
import {
  LogProvider,
  type MessageChannel,
  type MessageProvider,
  type OutgoingMessage,
  type SendResult,
} from '@hatti/messaging/public';
import { describe, expect, it } from 'vitest';
import { SesMessageEmails } from './emails.js';
import { ProviderPhoneCodes, messageProvidersOf } from './messaging.js';

/** A channel's provider answering as told, keeping each message it is given. */
const provider = (
  channel: MessageChannel,
  answer: () => Promise<SendResult>,
  given: OutgoingMessage[],
): MessageProvider => ({
  name: `test_${channel}`,
  channel,
  send: async (message) => {
    given.push(message);
    return answer();
  },
});

const delivered = async (): Promise<SendResult> => ({ ok: true, providerMessageId: 'wamid.1' });
const code = { phone: '+923001234567', code: '048213', language: 'ur' } as const;

describe("Merchants' sign-in codes (ADR-159)", () => {
  it('sends on the channel asked for, on the other when that one cannot deliver, and says which', async () => {
    const given: OutgoingMessage[] = [];
    const warned: unknown[] = [];
    const codes = new ProviderPhoneCodes(
      {
        whatsapp: provider(
          'whatsapp',
          async () => ({ ok: false, outcome: 'replace', error: 'Not on WhatsApp' }),
          given,
        ),
        sms: provider('sms', delivered, given),
      },
      { warn: (fields: unknown) => void warned.push(fields) },
    );
    expect(await codes.send({ ...code, channel: 'whatsapp' })).toBe('sms');
    expect(
      given.map((message) => [
        message.channel,
        message.kind,
        message.recipient,
        message.language,
        message.variables,
      ]),
    ).toEqual(
      ['whatsapp', 'sms'].map((channel) => [
        channel,
        'sign_in_code',
        '+923001234567',
        'ur',
        { shop: 'Hatti', code: '048213' },
      ]),
    );
    expect(warned).toEqual([{ channel: 'whatsapp', error: 'Not on WhatsApp' }]);
    // By SMS when asked: WhatsApp is not tried.
    given.length = 0;
    expect(await codes.send({ ...code, channel: 'sms' })).toBe('sms');
    expect(given.map((message) => message.channel)).toEqual(['sms']);
  });

  it('says none went when no channel could send it, or the one set up is not the one asked', async () => {
    const given: OutgoingMessage[] = [];
    const neither = new ProviderPhoneCodes({
      whatsapp: provider(
        'whatsapp',
        async () => {
          throw new Error('socket hang up');
        },
        given,
      ),
      sms: provider('sms', async () => ({ ok: false, outcome: 'retry', error: 'Busy' }), given),
    });
    expect(await neither.send({ ...code, channel: 'whatsapp' })).toBeNull();
    expect(given.map((message) => message.channel)).toEqual(['whatsapp', 'sms']);
    // Only SMS set up: a code asked for on WhatsApp goes by SMS.
    const smsAlone = new ProviderPhoneCodes({ sms: provider('sms', delivered, []) });
    expect(await smsAlone.send({ ...code, channel: 'whatsapp' })).toBe('sms');
    expect(await new ProviderPhoneCodes({}).send({ ...code, channel: 'sms' })).toBeNull();
  });

  it('tells a number another took the place of, on WhatsApp else by SMS (ADR-173)', async () => {
    const given: OutgoingMessage[] = [];
    const codes = new ProviderPhoneCodes({
      whatsapp: provider(
        'whatsapp',
        async () => ({ ok: false, outcome: 'replace', error: 'Not on WhatsApp' }),
        given,
      ),
      sms: provider('sms', delivered, given),
    });
    const told = { phone: '+923001234567', replacedBy: '+92 321 •••4321', language: 'en' } as const;
    expect(await codes.tellReplaced(told)).toBe('sms');
    expect(
      given.map((message) => [message.channel, message.kind, message.recipient, message.variables]),
    ).toEqual(
      ['whatsapp', 'sms'].map((channel) => [
        channel,
        'number_replaced',
        '+923001234567',
        { shop: 'Hatti', phone: '+92 321 •••4321' },
      ]),
    );
    expect(await new ProviderPhoneCodes({}).tellReplaced(told)).toBeNull();
  });

  it('tells a number of a sign-in from a device new to its account (ADR-179)', async () => {
    const given: OutgoingMessage[] = [];
    const codes = new ProviderPhoneCodes({
      whatsapp: provider('whatsapp', delivered, given),
      sms: provider('sms', delivered, given),
    });
    const told = {
      phone: '+923001234567',
      device: 'Chrome on Windows',
      date: '5 Oct, 3:04 pm',
      language: 'ur',
    } as const;
    expect(await codes.tellSignedIn(told)).toBe('whatsapp');
    expect(
      given.map((message) => [message.channel, message.kind, message.language, message.variables]),
    ).toEqual([
      [
        'whatsapp',
        'sign_in_alert',
        'ur',
        { shop: 'Hatti', device: 'Chrome on Windows', date: '5 Oct, 3:04 pm' },
      ],
    ]);
    expect(await new ProviderPhoneCodes({}).tellSignedIn(told)).toBeNull();
  });
});

describe('How each channel sends (ADR-146)', () => {
  const logger = createLogger({ name: 'messaging-test', level: 'silent' });
  const local = {
    NODE_ENV: 'development',
    META_GRAPH_URL: 'https://graph.facebook.com',
    META_GRAPH_VERSION: 'v26.0',
    SMS_SENDER: 'Hatti',
    EMAIL_FROM: 'Hatti <no-reply@hatti.pk>',
  };

  it("sends orders' emails through SES where it is set up, to the log in development (ADR-181)", () => {
    const development = messageProvidersOf(local, logger);
    expect(Object.keys(development).sort()).toEqual(['email', 'sms', 'whatsapp']);
    expect(development.email).toBeInstanceOf(LogProvider);
    expect(development.email?.channel).toBe('email');
    // Nothing set up in production: each fails as unsent.
    expect(messageProvidersOf({ ...local, NODE_ENV: 'production' }, logger)).toEqual({});
    const production = messageProvidersOf(
      {
        ...local,
        NODE_ENV: 'production',
        SES_REGION: 'ap-southeast-1',
        SES_ACCESS_KEY_ID: 'AKIAHATTITEST0000001',
        SES_SECRET_ACCESS_KEY: 's'.repeat(40),
      },
      logger,
    );
    expect(Object.keys(production)).toEqual(['email']);
    expect(production.email).toBeInstanceOf(SesMessageEmails);
    expect(production.email?.name).toBe('ses');
  });
});
