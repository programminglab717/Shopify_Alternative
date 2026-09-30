import { describe, expect, it } from 'vitest';
import { CloudflareCache, NO_EDGE_CACHE } from './edge-cache.js';

describe('The edge cache', () => {
  it("purges Cloudflare's cache by tag, thirty at a time, with the zone's token", async () => {
    const calls: { url: string; auth: string | null; tags: string[] }[] = [];
    const cache = new CloudflareCache({
      zoneId: 'zone-1',
      token: 'cf-token',
      fetch: async (input, init) => {
        const request = new Request(input, init);
        calls.push({
          url: request.url,
          auth: request.headers.get('authorization'),
          tags: ((await request.json()) as { tags: string[] }).tags,
        });
        return Response.json({ success: true });
      },
    });
    const tags = Array.from({ length: 31 }, (_, index) => `hatti:shop:product:p${index}`);
    await cache.purge([...tags, tags[0]!]);
    expect(calls.map((call) => [call.url, call.auth, call.tags.length])).toEqual([
      ['https://api.cloudflare.com/client/v4/zones/zone-1/purge_cache', 'Bearer cf-token', 30],
      ['https://api.cloudflare.com/client/v4/zones/zone-1/purge_cache', 'Bearer cf-token', 1],
    ]);
    expect(calls[1]!.tags).toEqual(['hatti:shop:product:p30']);
  });

  it('says when Cloudflare refuses, and nothing is purged without an edge', async () => {
    const refusing = new CloudflareCache({
      zoneId: 'zone-1',
      token: 'cf-token',
      fetch: async () => new Response('{"success":false}', { status: 403 }),
    });
    await expect(refusing.purge(['hatti:shop'])).rejects.toThrow('Cloudflare answered 403');
    await expect(NO_EDGE_CACHE.purge(['hatti:shop'])).resolves.toBeUndefined();
  });
});
