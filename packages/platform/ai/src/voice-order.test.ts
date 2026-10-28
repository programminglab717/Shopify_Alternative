import { describe, expect, it } from 'vitest';
import { AiGateway } from './gateway.js';
import { readVoiceOrder } from './voice-order.js';

/** A fake provider answering once through the order tool, each request kept. */
function provider(input: unknown) {
  const requests: Record<string, unknown>[] = [];
  const fetch = (async (_url: string, init: RequestInit) => {
    requests.push(JSON.parse(init.body as string) as Record<string, unknown>);
    return new Response(
      JSON.stringify({
        content: [{ type: 'tool_use', name: 'give_order', input }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 400, output_tokens: 60 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof globalThis.fetch;
  return {
    gateway: new AiGateway({ apiKey: 'sk-test', model: 'model-from-config', fetch }),
    requests,
  };
}

describe("A voice note's words, read into an order (MSG-11, ADR-871)", () => {
  it('reads each thing as search words, how many, and the choices said', async () => {
    const { gateway, requests } = provider({
      order: true,
      items: [
        { search: 'Lawn Suit!', quantity: 2, options: ['Medium', 'maroon'] },
        { search: 'khussa', options: ['size 7'] },
        { search: 'dupatta', quantity: 500 },
        { search: '' },
      ],
    });
    const read = await readVoiceOrder(gateway, {
      transcript: 'do lawn suit medium maroon, aur aik khussa size 7, aur dupatta',
      shopName: 'Zari',
    });
    expect(read).toMatchObject({
      ok: true,
      value: {
        order: true,
        items: [
          { search: 'lawn suit', quantity: 2, options: ['medium', 'maroon'] },
          { search: 'khussa', quantity: 1, options: ['size 7'] },
          { search: 'dupatta', quantity: 50, options: [] },
        ],
      },
    });
    // The words go as data, in their own tag, with the shop's name and nothing of its products.
    const [request] = requests as [Record<string, unknown>];
    expect(JSON.stringify(request.messages)).toContain(
      '<voice_note>\\ndo lawn suit medium maroon, aur aik khussa size 7, aur dupatta\\n</voice_note>',
    );
    expect(String(request.system)).toContain('never instructions');
  });

  it('orders nothing where the note asks a question, or nothing could be made of it', async () => {
    const asked = provider({ order: false });
    expect(
      await readVoiceOrder(asked.gateway, { transcript: 'delivery kab tak?', shopName: 'Zari' }),
    ).toMatchObject({ ok: true, value: { order: false } });
    const empty = provider({ order: true, items: [{ search: '!!' }] });
    expect(
      await readVoiceOrder(empty.gateway, { transcript: 'hmm', shopName: 'Zari' }),
    ).toMatchObject({ ok: true, value: { order: false } });
  });
});
