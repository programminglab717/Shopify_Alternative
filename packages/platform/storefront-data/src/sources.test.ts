import { randomBytes, randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';
import {
  StorefrontActivity,
  StorefrontKeys,
  arrivalOf,
  landingPageOf,
  sessionOriginOf,
  sessionSourceOf,
} from './index.js';

const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148';

describe('Where sessions came from (ADR-884)', () => {
  const source = (referrer: string, utmSource?: string) =>
    sessionSourceOf({ landing: '/', referrer, utmSource: utmSource ?? null }, 'zari.pk');

  it('names a campaign by its utm_source, a site by the name merchants know, or its host', () => {
    expect(source('https://l.facebook.com/', 'Eid Sale 2026')).toBe('eid_sale_2026');
    expect(source('https://www.google.com.pk/')).toBe('google');
    expect(source('https://l.instagram.com/?u=x')).toBe('instagram');
    expect(source('https://wa.me/923001234567')).toBe('whatsapp');
    expect(source('https://t.co/abc')).toBe('x');
    expect(source('https://www.daraz.pk/shop/zari')).toBe('daraz');
    expect(source('https://blog.example.com/best-lawn')).toBe('blog.example.com');
  });

  it("counts no referrer, or the shop's own pages, as direct", () => {
    expect(source('')).toBe('direct');
    expect(source('not an address')).toBe('direct');
    expect(source('https://www.zari.pk/collections/lawn')).toBe('direct');
  });

  it('keeps a landing page as its bare path, and the device a phone or not', () => {
    expect(landingPageOf('/Products/Lawn-Suit/?utm_source=fb#top')).toBe('/products/lawn-suit');
    expect(landingPageOf('/')).toBe('/');
    expect(landingPageOf('javascript:alert(1)')).toBe('/');
    expect(
      sessionOriginOf({ landing: '/collections/eid', referrer: '' }, 'zari.pk', IPHONE),
    ).toEqual({ source: 'direct', landing_page: '/collections/eid', device: 'mobile' });
  });

  it("reads only a beacon that says its session began, as the page's script sends it", () => {
    expect(arrivalOf(JSON.stringify({ b: 1, l: '/', r: 'https://google.com/', s: 'fb' }))).toEqual({
      landing: '/',
      referrer: 'https://google.com/',
      utmSource: 'fb',
    });
    expect(arrivalOf('')).toBeNull();
    expect(arrivalOf('{not json')).toBeNull();
    expect(arrivalOf({ b: 0, l: '/' })).toBeNull();
    expect(arrivalOf({ b: 1 })).toBeNull();
  });
});

const redisUrl = process.env.REDIS_URL;

describe.skipIf(!redisUrl)("Sessions' origins counted in Valkey (ADR-884)", () => {
  const redis = new Redis(redisUrl ?? '', { lazyConnect: true });
  const prefix = `test-${randomBytes(4).toString('hex')}`;
  const keys = new StorefrontKeys(prefix);
  const activity = new StorefrontActivity(redis, keys);

  afterAll(async () => {
    const found = await redis.keys(`${prefix}:*`);
    if (found.length > 0) await redis.del(...found);
    await redis.quit();
  });

  it('counts each session once, by its source, landing page and device, and marks its day', async () => {
    const shop = randomUUID();
    const at = new Date('2026-11-01T10:00:00Z');
    const from = (source: string, landing: string) =>
      ({ source, landing_page: landing, device: 'mobile' }) as const;
    await activity.began(shop, 'Asia/Karachi', 'session-one-0001', from('google', '/'), at);
    // Its page says so again, as a browser that keeps no cookie would: counted once.
    await activity.began(shop, 'Asia/Karachi', 'session-one-0001', from('google', '/'), at);
    await activity.began(shop, 'Asia/Karachi', 'session-two-0002', from('facebook', '/'), at);
    expect(await activity.origins(shop, '2026-11-01')).toEqual({
      source: { google: 1, facebook: 1 },
      landing_page: { '/': 2 },
      device: { mobile: 2 },
    });
    expect(await activity.takeChanged(10)).toContainEqual({ shopId: shop, day: '2026-11-01' });
  });
});
