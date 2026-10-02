import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SmsGatewayProvider, WhatsAppCloudProvider, type OutgoingMessage } from './providers.js';
import { asksToStop, messageText, templateParameters } from './templates.js';
import { parseWhatsAppWebhook, signatureValid } from './whatsapp-webhook.js';

const SHIPPED: OutgoingMessage = {
  id: '01a0f3b1-9685-7065-988d-604298214e34',
  kind: 'order_shipped',
  channel: 'whatsapp',
  recipient: '+923001234567',
  language: 'en',
  variables: {
    shop: 'Zari Fashions',
    order: '#1043',
    courier: 'PostEx',
    tracking: 'PX123456',
    url: 'https://postex.pk/track/PX123456',
  },
};

describe("Messages' words", () => {
  it('fills in an SMS, its tracking link after it, in English and Urdu', () => {
    expect(messageText('order_shipped', 'en', SHIPPED.variables)).toBe(
      'Your order #1043 from Zari Fashions is on its way with PostEx. Tracking number: ' +
        'PX123456. https://postex.pk/track/PX123456',
    );
    const urdu = messageText('order_placed', 'ur', {
      name: 'Ayesha',
      shop: 'Zari Fashions',
      order: '#1043',
      total: 'Rs 5,250',
    });
    expect(urdu).toContain('Ayesha');
    expect(urdu).toContain('#1043 (Rs 5,250)');
    expect(urdu).toMatch(/\p{Script=Arabic}/u);
  });

  it("gives WhatsApp's template its variables in order, a dash for one it lacks", () => {
    expect(templateParameters('order_shipped', SHIPPED.variables)).toEqual([
      'Zari Fashions',
      '#1043',
      'PostEx',
      'PX123456',
    ]);
    expect(
      templateParameters('order_placed', { shop: 'Zari', order: '#7', total: 'Rs 900' }),
    ).toEqual(['-', 'Zari', '#7', 'Rs 900']);
  });

  it('hears a customer asking to stop, in English, Roman Urdu and Urdu, and nothing else', () => {
    const urdu = String.fromCharCode(0x628, 0x646, 0x62f, 0x20, 0x6a9, 0x631, 0x648);
    for (const said of ['STOP', ' stop! ', 'Band karo', 'band  kro', urdu, 'Unsubscribe.']) {
      expect(asksToStop(said), said).toBe(true);
    }
    for (const said of ['stop sending the blue one', 'where is my order?', 'band', '']) {
      expect(asksToStop(said), said).toBe(false);
    }
  });
});

describe("WhatsApp's webhook", () => {
  const body = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              statuses: [
                { id: 'wamid.1', status: 'delivered', timestamp: '1790940000' },
                {
                  id: 'wamid.2',
                  status: 'failed',
                  timestamp: '1790940060',
                  errors: [{ code: 131026, title: 'Message undeliverable' }],
                },
                { id: 'wamid.3', status: 'deleted', timestamp: '1790940060' },
              ],
              messages: [
                {
                  from: '923001234567',
                  id: 'wamid.in',
                  timestamp: '1790940120',
                  type: 'text',
                  text: { body: 'Band karo' },
                },
                {
                  from: '923007654321',
                  type: 'button',
                  timestamp: '1790940180',
                  context: { from: '15550001111', id: 'wamid.asked' },
                  button: { payload: 'x', text: 'Stop' },
                },
                { from: '+92 300', type: 'text', text: { body: 'stop' } },
              ],
            },
          },
          { field: 'account_update', value: {} },
        ],
      },
    ],
  };

  it('reads statuses and replies, leaving out what it does not know', () => {
    expect(parseWhatsAppWebhook(body)).toEqual({
      statuses: [
        {
          providerMessageId: 'wamid.1',
          status: 'delivered',
          at: new Date(1790940000_000),
          error: null,
        },
        {
          providerMessageId: 'wamid.2',
          status: 'failed',
          at: new Date(1790940060_000),
          error: 'WhatsApp 131026: Message undeliverable',
        },
      ],
      inbound: [
        {
          from: '+923001234567',
          text: 'Band karo',
          replyTo: null,
          at: new Date(1790940120_000),
        },
        {
          from: '+923007654321',
          text: 'Stop',
          replyTo: 'wamid.asked',
          at: new Date(1790940180_000),
        },
      ],
    });
    expect(parseWhatsAppWebhook(null)).toEqual({ statuses: [], inbound: [] });
    expect(parseWhatsAppWebhook({ entry: 'x' })).toEqual({ statuses: [], inbound: [] });
  });

  it("takes only bodies signed with the app's secret", () => {
    const raw = Buffer.from(JSON.stringify(body));
    const signed = `sha256=${createHmac('sha256', 'app-secret').update(raw).digest('hex')}`;
    expect(signatureValid(raw, signed, 'app-secret')).toBe(true);
    expect(signatureValid(raw, signed, 'another-secret')).toBe(false);
    expect(signatureValid(Buffer.concat([raw, Buffer.from(' ')]), signed, 'app-secret')).toBe(
      false,
    );
    expect(signatureValid(raw, undefined, 'app-secret')).toBe(false);
    expect(signatureValid(raw, 'sha256=00', 'app-secret')).toBe(false);
  });
});

describe('Providers', () => {
  let server: Server;
  let baseUrl: string;
  const requests: { url: string; headers: IncomingMessage['headers']; body: unknown }[] = [];
  let answer: { status: number; body: unknown } = { status: 200, body: {} };

  beforeAll(async () => {
    server = createServer((request, response) => {
      let text = '';
      request.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
      request.on('end', () => {
        requests.push({ url: request.url ?? '', headers: request.headers, body: JSON.parse(text) });
        response.writeHead(answer.status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(answer.body));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("sends WhatsApp's template from Hatti's number, and says what to do when it is refused", async () => {
    const whatsapp = new WhatsAppCloudProvider({
      baseUrl: `${baseUrl}/`,
      version: 'v26.0',
      phoneNumberId: '1098765432',
      accessToken: 'EAAG-system-user-token',
    });
    answer = { status: 200, body: { messages: [{ id: 'wamid.HBgM' }] } };
    expect(await whatsapp.send(SHIPPED)).toEqual({ ok: true, providerMessageId: 'wamid.HBgM' });
    const [sent] = requests.splice(0);
    expect(sent!.url).toBe('/v26.0/1098765432/messages');
    expect(sent!.headers.authorization).toBe('Bearer EAAG-system-user-token');
    expect(sent!.body).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '923001234567',
      type: 'template',
      template: {
        name: 'hatti_order_shipped',
        language: { code: 'en' },
        components: [
          {
            type: 'body',
            parameters: ['Zari Fashions', '#1043', 'PostEx', 'PX123456'].map((text) => ({
              type: 'text',
              text,
            })),
          },
        ],
      },
    });

    const refused = async (status: number, error: Record<string, unknown>) => {
      answer = { status, body: { error } };
      return whatsapp.send(SHIPPED);
    };
    expect(await refused(400, { code: 131026, message: 'Message undeliverable' })).toEqual({
      ok: false,
      outcome: 'replace',
      error: 'WhatsApp 131026: Message undeliverable',
    });
    expect(await refused(400, { code: 130429, message: 'Rate limit hit' })).toMatchObject({
      outcome: 'retry',
    });
    expect(await refused(503, { code: 2, message: 'Service unavailable' })).toMatchObject({
      outcome: 'retry',
    });
    expect(await refused(400, { code: 132001, message: 'Template does not exist' })).toMatchObject({
      outcome: 'replace',
    });
    requests.splice(0);
    const nowhere = new WhatsAppCloudProvider({
      baseUrl: 'http://127.0.0.1:1',
      version: 'v26.0',
      phoneNumberId: '1',
      accessToken: 'x',
      timeoutMs: 2_000,
    });
    expect(await nowhere.send(SHIPPED)).toMatchObject({ ok: false, outcome: 'retry' });
  });

  it("sends an SMS's words through the gateway, and gives up only on what it refuses", async () => {
    const sms = new SmsGatewayProvider({
      url: `${baseUrl}/sms`,
      apiKey: 'gateway-key',
      sender: 'Hatti',
    });
    const message = { ...SHIPPED, channel: 'sms' as const, language: 'ur' as const };
    answer = { status: 200, body: { id: 77 } };
    expect(await sms.send(message)).toEqual({ ok: true, providerMessageId: '77' });
    const [sent] = requests.splice(0);
    expect(sent!.headers.authorization).toBe('Bearer gateway-key');
    expect(sent!.body).toEqual({
      to: '+923001234567',
      text: messageText('order_shipped', 'ur', SHIPPED.variables),
      sender: 'Hatti',
    });
    // Taken without an ID: sent all the same, never twice.
    answer = { status: 202, body: {} };
    expect(await sms.send(message)).toEqual({ ok: true, providerMessageId: `sms-${SHIPPED.id}` });
    answer = { status: 429, body: { error: 'slow down' } };
    expect(await sms.send(message)).toMatchObject({ ok: false, outcome: 'retry' });
    answer = { status: 400, body: { error: 'invalid number' } };
    expect(await sms.send(message)).toEqual({
      ok: false,
      outcome: 'fail',
      error: 'SMS gateway 400: invalid number',
    });
    requests.splice(0);
  });
});
