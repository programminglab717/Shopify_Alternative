import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { messageCostOf, smsParts } from './charges.js';
import { SmsGatewayProvider, WhatsAppCloudProvider, type OutgoingMessage } from './providers.js';
import {
  ALWAYS_SENT,
  MESSAGE_KINDS,
  asksToStop,
  messageText,
  paidByShop,
  templateButtons,
  templateParameters,
} from './templates.js';
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
    // The order's page, where its parcel's way shows (ADR-160).
    url: 'https://hatti.pk/o/Zx8kQ2mN4pR6sT0vW1yA3b',
  },
};

describe("Messages' words", () => {
  it("fills in an SMS, its order's page after it, in English and Urdu", () => {
    expect(messageText('order_shipped', 'en', SHIPPED.variables)).toBe(
      'Your order #1043 from Zari Fashions is on its way with PostEx. Tracking number: ' +
        'PX123456. https://hatti.pk/o/Zx8kQ2mN4pR6sT0vW1yA3b',
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

  it("asks to confirm with the order's link by SMS, and with buttons on WhatsApp", () => {
    const asking = {
      name: 'Ayesha',
      shop: 'Zari Fashions',
      order: '#1043',
      total: 'Rs 5,250',
      url: 'https://hatti.pk/o/Zx8kQ2mN4pR6sT0vW1yA3b',
    };
    expect(messageText('order_confirmation', 'en', asking)).toBe(
      'Assalam-o-Alaikum Ayesha! Please confirm your order #1043 from Zari Fashions for ' +
        'Rs 5,250, paid in cash on delivery, so they can send it. Confirm or cancel it here: ' +
        'https://hatti.pk/o/Zx8kQ2mN4pR6sT0vW1yA3b',
    );
    expect(messageText('order_confirmation', 'ur', asking)).toMatch(
      /\p{Script=Arabic}.* https:\/\/hatti\.pk\/o\/Zx8kQ2mN4pR6sT0vW1yA3b$/u,
    );
    expect(templateParameters('order_confirmation', asking)).toEqual([
      'Ayesha',
      'Zari Fashions',
      '#1043',
      'Rs 5,250',
    ]);
    expect(templateButtons('order_confirmation', asking)).toEqual(
      ['confirm', 'cancel', 'address'].map((payload, index) => ({
        type: 'button',
        sub_type: 'quick_reply',
        index: String(index),
        parameters: [{ type: 'payload', payload }],
      })),
    );
    // The page to change the address: the template's URL ends with the link's last part.
    expect(templateButtons('order_address', asking)).toEqual([
      {
        type: 'button',
        sub_type: 'url',
        index: '0',
        parameters: [{ type: 'text', text: 'Zx8kQ2mN4pR6sT0vW1yA3b' }],
      },
    ]);
    // Shipped, and out for delivery: a button to the order's page (ADR-160).
    for (const kind of ['order_shipped', 'order_out_for_delivery'] as const) {
      expect(templateButtons(kind, SHIPPED.variables)).toEqual([
        {
          type: 'button',
          sub_type: 'url',
          index: '0',
          parameters: [{ type: 'text', text: 'Zx8kQ2mN4pR6sT0vW1yA3b' }],
        },
      ]);
    }
    expect(templateButtons('order_delivered', SHIPPED.variables)).toEqual([]);
  });

  it('tells a customer paying on delivery what to keep ready as their parcel goes out (ADR-160)', () => {
    const out = { shop: 'Zari Fashions', order: '#1043', due: 'Rs 5,250' };
    expect(messageText('order_out_for_delivery', 'en', out)).toBe(
      'Your order #1043 from Zari Fashions is out for delivery today. Please keep Rs 5,250 ready ' +
        'for the rider.',
    );
    expect(messageText('order_out_for_delivery', 'ur', out)).toMatch(
      /^Zari Fashions \p{Script=Arabic}.*#1043.*Rs 5,250/u,
    );
    expect(templateParameters('order_out_for_delivery', out)).toEqual([
      'Zari Fashions',
      '#1043',
      'Rs 5,250',
    ]);
  });

  it('tells the shop of a variant running low or out, at its alerts number (ADR-157)', () => {
    const stock = { shop: 'Zari Fashions', product: 'Lawn Kurta (S)', stock: '4' };
    expect(messageText('stock_low', 'en', stock)).toBe(
      'Zari Fashions: Lawn Kurta (S) is running low, with 4 left for sale online. Restock it in ' +
        'Hatti.',
    );
    expect(templateParameters('stock_low', stock)).toEqual([
      'Zari Fashions',
      'Lawn Kurta (S)',
      '4',
    ]);
    expect(messageText('stock_out', 'en', stock)).toBe(
      'Zari Fashions: Lawn Kurta (S) is out of stock online. Restock it in Hatti.',
    );
    expect(templateParameters('stock_out', stock)).toEqual(['Zari Fashions', 'Lawn Kurta (S)']);
    expect(messageText('stock_out', 'ur', stock)).toContain('Lawn Kurta (S)');
  });

  it("tells the shop of its bills with Hatti, at Hatti's cost (ADR-169)", () => {
    const due = { shop: 'Zari Fashions', invoice: 'HT-1042', plan: 'Starter', amount: 'Rs 2,499' };
    expect(messageText('invoice_due', 'en', due)).toBe(
      "Hatti: invoice HT-1042 for Zari Fashions's next period on Starter, Rs 2,499, waits for " +
        "payment. Pay it from Hatti's admin to keep the plan.",
    );
    expect(templateParameters('invoice_due', due)).toEqual([
      'Zari Fashions',
      'HT-1042',
      'Starter',
      'Rs 2,499',
    ]);
    expect(messageText('invoice_due', 'ur', due)).toContain('HT-1042');
    expect(templateParameters('plan_ended', { shop: 'Zari Fashions' })).toEqual(['Zari Fashions']);
    const low = { shop: 'Zari Fashions', balance: 'Rs 95.76' };
    expect(messageText('credit_low', 'en', low)).toBe(
      "Hatti: Zari Fashions's message credit is down to Rs 95.76. Messages to customers wait " +
        "once it runs out: buy more from Hatti's admin.",
    );
    expect(templateParameters('credit_low', low)).toEqual(['Zari Fashions', 'Rs 95.76']);
    // Never from the shop's credit, which may be what the notice is about; always sent.
    expect(MESSAGE_KINDS.filter((kind) => !paidByShop(kind))).toEqual([
      'invoice_due',
      'plan_ended',
      'credit_low',
    ]);
    expect(ALWAYS_SENT).toEqual(['one_time_code', 'invoice_due', 'plan_ended', 'credit_low']);
  });

  it('carries a code in its words and in the button that copies it', () => {
    const code = { shop: 'Zari Fashions', code: '048213' };
    expect(messageText('one_time_code', 'en', code)).toBe(
      '048213 is your code to place your order with Zari Fashions. It works for 10 minutes. ' +
        'Never share it.',
    );
    expect(templateParameters('one_time_code', code)).toEqual(['048213']);
    expect(templateButtons('one_time_code', code)).toEqual([
      {
        type: 'button',
        sub_type: 'url',
        index: '0',
        parameters: [{ type: 'text', text: '048213' }],
      },
    ]);
    // Hatti's own, signing a merchant in (ADR-159): the same button, from Hatti.
    const signIn = { shop: 'Hatti', code: '731904' };
    expect(messageText('sign_in_code', 'en', signIn)).toBe(
      '731904 is your Hatti code. It works for 10 minutes. Never share it, not even with Hatti.',
    );
    expect(messageText('sign_in_code', 'ur', signIn)).toMatch(/^\p{Script=Arabic}.* 731904 /u);
    expect(templateParameters('sign_in_code', signIn)).toEqual(['731904']);
    expect(templateButtons('sign_in_code', signIn)).toEqual([
      {
        type: 'button',
        sub_type: 'url',
        index: '0',
        parameters: [{ type: 'text', text: '731904' }],
      },
    ]);
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

describe('What a message costs', () => {
  it("counts an SMS's parts as gateways charge them: GSM's 160, or Urdu's 70", () => {
    // GSM's alphabet: 160 alone, 153 a part of a longer one; its extension counts two.
    expect(smsParts('a'.repeat(160))).toBe(1);
    expect(smsParts('a'.repeat(161))).toBe(2);
    expect(smsParts('a'.repeat(306))).toBe(2);
    expect(smsParts('a'.repeat(307))).toBe(3);
    expect(smsParts('Δ£é@'.repeat(40))).toBe(1);
    expect(smsParts('{'.repeat(80))).toBe(1);
    expect(smsParts('{'.repeat(81))).toBe(2);
    // Urdu, or any character GSM lacks: 70 alone, 67 a part.
    const ur = String.fromCharCode(0x6a9);
    expect(smsParts(ur.repeat(70))).toBe(1);
    expect(smsParts(ur.repeat(71))).toBe(2);
    expect(smsParts(ur.repeat(134))).toBe(2);
    expect(smsParts(ur.repeat(135))).toBe(3);
    expect(smsParts(`${'a'.repeat(69)}ç`)).toBe(1);
    expect(smsParts(`${'a'.repeat(70)}ç`)).toBe(2);
  });

  it("prices a message by its channel, its template's category, and its SMS's parts", () => {
    const shipped = { kind: 'order_shipped', variables: SHIPPED.variables } as const;
    expect(messageCostOf({ ...shipped, channel: 'whatsapp', language: 'ur' })).toEqual({
      channel: 'whatsapp',
      category: 'utility',
      parts: 1,
    });
    expect(messageCostOf({ ...shipped, channel: 'sms', language: 'en' })).toEqual({
      channel: 'sms',
      category: 'utility',
      parts: 1,
    });
    expect(messageCostOf({ ...shipped, channel: 'sms', language: 'ur' })).toEqual({
      channel: 'sms',
      category: 'utility',
      parts: 2,
    });
    const code = { shop: 'Zari Fashions', code: '048213' };
    expect(
      messageCostOf({ kind: 'one_time_code', channel: 'sms', language: 'en', variables: code }),
    ).toEqual({ channel: 'sms', category: 'authentication', parts: 1 });
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
                {
                  from: '923335550001',
                  type: 'interactive',
                  timestamp: '1790940240',
                  context: { id: 'wamid.confirm' },
                  interactive: {
                    type: 'button_reply',
                    button_reply: { id: 'confirm', title: 'Confirm order' },
                  },
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
          payload: null,
          at: new Date(1790940120_000),
        },
        {
          from: '+923007654321',
          text: 'Stop',
          replyTo: 'wamid.asked',
          payload: 'x',
          at: new Date(1790940180_000),
        },
        {
          from: '+923335550001',
          text: 'Confirm order',
          replyTo: 'wamid.confirm',
          payload: 'confirm',
          at: new Date(1790940240_000),
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
          {
            type: 'button',
            sub_type: 'url',
            index: '0',
            parameters: [{ type: 'text', text: 'Zx8kQ2mN4pR6sT0vW1yA3b' }],
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
