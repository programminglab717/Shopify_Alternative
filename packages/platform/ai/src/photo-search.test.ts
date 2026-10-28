import { describe, expect, it } from 'vitest';
import { AiGateway } from './gateway.js';
import { readPhotoForSearch } from './photo-search.js';

/** A fake provider answering once through the searches tool, each request kept. */
function provider(input: unknown) {
  const requests: Record<string, unknown>[] = [];
  const fetch = (async (_url: string, init: RequestInit) => {
    requests.push(JSON.parse(init.body as string) as Record<string, unknown>);
    return new Response(
      JSON.stringify({
        content: [{ type: 'tool_use', name: 'give_searches', input }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 900, output_tokens: 40 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof globalThis.fetch;
  return {
    gateway: new AiGateway({ apiKey: 'sk-test', model: 'model-from-config', fetch }),
    requests,
  };
}

const JPEG = { mediaType: 'image/jpeg' as const, data: Buffer.from([0xff, 0xd8, 0xff, 1]) };

describe("A shopper's photo, read into searches (SRC-07, ADR-870)", () => {
  it('reads plain searches, the most particular first, a few words each, the photo sent alone', async () => {
    const { gateway, requests } = provider({
      product: true,
      searches: [
        'Maroon Embroidered Lawn Suit, 3-piece (Unstitched!)',
        'lawn suit',
        'Lawn  Suit',
        'suit',
        'kurta',
      ],
    });
    expect(await readPhotoForSearch(gateway, JPEG)).toMatchObject({
      ok: true,
      value: {
        product: true,
        searches: ['maroon embroidered lawn suit 3-piece', 'lawn suit', 'suit'],
      },
    });
    const content = (requests[0]!.messages as { content: { type: string }[] }[])[0]!.content;
    expect(content.map((part) => part.type)).toEqual(['image', 'text']);
  });

  it('says when the photo shows no product, and refuses an answer with no search', async () => {
    expect(await readPhotoForSearch(provider({ product: false }).gateway, JPEG)).toMatchObject({
      ok: true,
      value: { product: false },
    });
    expect(
      await readPhotoForSearch(provider({ product: true, searches: ['  ', '!!'] }).gateway, JPEG),
    ).toMatchObject({ ok: false, reason: 'invalid' });
  });
});
