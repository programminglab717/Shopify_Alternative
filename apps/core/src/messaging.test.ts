import type {
  MessageChannel,
  MessageProvider,
  OutgoingMessage,
  SendResult,
} from '@hatti/messaging/public';
import { describe, expect, it } from 'vitest';
import { ProviderPhoneCodes } from './messaging.js';

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
