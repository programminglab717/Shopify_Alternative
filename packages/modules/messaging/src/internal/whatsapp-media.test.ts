import { afterEach, describe, expect, it, vi } from 'vitest';
import { WhatsAppCloudProvider } from './providers.js';

const provider = new WhatsAppCloudProvider({
  baseUrl: 'https://graph.example/',
  version: 'v26.0',
  phoneNumberId: '1098765432',
  accessToken: 'EAAG-token',
});

/** WhatsApp's Graph API, faked: where the media is, then the media, each request kept. */
function graph(about: { status: number; body: unknown }, bytes = Buffer.from('OggS voice')) {
  const asked: { url: string; authorization: string | undefined }[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    asked.push({ url, authorization: (init.headers as Record<string, string>).authorization });
    return url.startsWith('https://graph.example/')
      ? new Response(JSON.stringify(about.body), { status: about.status })
      : new Response(bytes, { status: 200 });
  });
  return asked;
}

describe("A message's media, fetched from WhatsApp (MSG-11, ADR-871)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it('asks where it is, then fetches it, both with the number’s token', async () => {
    const asked = graph({
      status: 200,
      body: { url: 'https://lookaside.example/m/1', mime_type: 'audio/ogg', file_size: 10 },
    });
    const media = await provider.media('1234567890', 1_000);
    expect(media).toEqual({ ok: true, data: Buffer.from('OggS voice'), mediaType: 'audio/ogg' });
    expect(asked).toEqual([
      { url: 'https://graph.example/v26.0/1234567890', authorization: 'Bearer EAAG-token' },
      { url: 'https://lookaside.example/m/1', authorization: 'Bearer EAAG-token' },
    ]);
  });

  it('refuses what is too large, unknown, or not at an https address', async () => {
    graph({ status: 200, body: { url: 'https://lookaside.example/m/1', file_size: 5_000 } });
    expect(await provider.media('1', 1_000)).toMatchObject({ ok: false, tooLarge: true });
    graph({ status: 200, body: { url: 'https://lookaside.example/m/1' } }, Buffer.alloc(2_000));
    expect(await provider.media('1', 1_000)).toMatchObject({ ok: false, tooLarge: true });
    graph({ status: 404, body: { error: { code: 100, message: 'Unknown media' } } });
    expect(await provider.media('1', 1_000)).toEqual({
      ok: false,
      tooLarge: false,
      error: 'WhatsApp 100: Unknown media',
    });
    const asked = graph({ status: 200, body: { url: 'http://elsewhere.example/m/1' } });
    expect(await provider.media('1', 1_000)).toMatchObject({ ok: false, tooLarge: false });
    expect(asked).toHaveLength(1);
  });
});
