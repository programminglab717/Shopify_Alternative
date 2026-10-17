import { describe, expect, it } from 'vitest';
import { WhatsAppCloudProvider } from './providers.js';
import {
  LIBRARY_KINDS,
  LIBRARY_LANGUAGES,
  libraryParameters,
  libraryTemplate,
  libraryVariables,
} from './template-library.js';
import { TEMPLATES, TO_THE_SHOP_KINDS } from './templates.js';

const PAGE = 'https://hatti.pk/o/';

describe("Hatti's order templates for shops' own numbers (ADR-537)", () => {
  it('lays each out as Meta takes it: variables in order, never at either end, words that fit', () => {
    expect(LIBRARY_KINDS).toContain('order_confirmation');
    expect(LIBRARY_KINDS).toContain('order_shipped');
    // Not codes, nor the gift card's, nor the shop's own alerts, nor marketing.
    for (const kind of [
      'one_time_code',
      'gift_card',
      'stock_low',
      'checkout_reminder',
      'broadcast',
    ]) {
      expect(LIBRARY_KINDS).not.toContain(kind);
    }
    for (const kind of LIBRARY_KINDS) {
      expect(TO_THE_SHOP_KINDS).not.toContain(kind);
      for (const language of LIBRARY_LANGUAGES) {
        const template = libraryTemplate(kind, language, PAGE);
        expect(template).toMatchObject({ name: TEMPLATES[kind].whatsapp, category: 'UTILITY' });
        const [body, buttons] = template.components as [
          { text: string; example?: { body_text: string[][] } },
          { buttons: { type: string; text: string; url?: string }[] } | undefined,
        ];
        const numbers = [...body.text.matchAll(/\{\{(\d+)\}\}/g)].map((match) => Number(match[1]));
        expect(numbers).toEqual(numbers.map((_, index) => index + 1));
        expect(body.example?.body_text[0] ?? []).toHaveLength(numbers.length);
        expect(libraryVariables(kind, language)).toHaveLength(numbers.length);
        expect(body.text).not.toMatch(/^\{\{|\}\}$/);
        expect(body.text.length).toBeLessThanOrEqual(1024);
        for (const button of buttons?.buttons ?? []) {
          expect(button.text.length).toBeLessThanOrEqual(25);
          if (button.type === 'URL') expect(button.url).toBe(`${PAGE}{{1}}`);
        }
      }
    }
  });

  it("sends its variables in the order its words name them, from the shop's number alone", async () => {
    const english = libraryTemplate('order_confirmation', 'en', PAGE).components[0] as {
      text: string;
    };
    expect(english.text).toBe(
      'Assalam-o-Alaikum {{1}}! Please confirm your order {{2}} from {{3}} for {{4}}, paid in ' +
        'cash on delivery, so they can send it. Confirm or cancel it here:',
    );
    const variables = { name: 'Ayesha', shop: 'Zari', order: '#1001', total: 'Rs 4,500' };
    expect(libraryParameters('order_confirmation', 'en', variables)).toEqual([
      'Ayesha',
      '#1001',
      'Zari',
      'Rs 4,500',
    ]);
    // The shop's name twice in Urdu is two variables.
    expect(libraryVariables('order_cancelled', 'ur')).toEqual(['shop', 'order', 'shop']);

    const bodies: unknown[] = [];
    const fetcher = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ messages: [{ id: 'wamid.1' }] }));
    }) as unknown as typeof fetch;
    try {
      const message = {
        id: 'm1',
        kind: 'order_confirmation' as const,
        channel: 'whatsapp' as const,
        recipient: '+923001234567',
        language: 'en' as const,
        variables,
      };
      const options = { baseUrl: 'https://graph', version: 'v26.0', accessToken: 'token' };
      await new WhatsAppCloudProvider({ ...options, phoneNumberId: '1' }).send(message);
      await new WhatsAppCloudProvider({ ...options, phoneNumberId: '2', shopNumber: true }).send(
        message,
      );
    } finally {
      globalThis.fetch = fetcher;
    }
    const texts = (
      bodies as { template: { components: { parameters: { text: string }[] }[] } }[]
    ).map((body) => body.template.components[0]!.parameters.map((each) => each.text));
    // Hatti's number has its templates as they always were.
    expect(texts).toEqual([
      ['Ayesha', 'Zari', '#1001', 'Rs 4,500'],
      ['Ayesha', '#1001', 'Zari', 'Rs 4,500'],
    ]);
  });
});
