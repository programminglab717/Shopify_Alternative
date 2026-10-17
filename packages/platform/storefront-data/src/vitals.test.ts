import { randomBytes, randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';
import {
  StorefrontKeys,
  StorefrontVitals,
  addHistograms,
  deviceOf,
  summarize,
  vitalBucket,
  vitalSampleOf,
} from './index.js';

const redisUrl = process.env.REDIS_URL;
if (!redisUrl && process.env.CI) throw new Error('REDIS_URL must be set in CI');

const PHONE = 'Mozilla/5.0 (Linux; Android 14; SM-A146B) AppleWebKit/537.36 Chrome/129 Mobile';
const LAPTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/129';

/** A histogram of `metric` with each of `values` once. */
function histogramOf(metric: 'lcp' | 'cls' | 'inp', values: number[]): number[] {
  return addHistograms(
    metric,
    values.map((value) => {
      const one = addHistograms(metric, []);
      one[vitalBucket(metric, value)] = 1;
      return one;
    }),
  );
}

describe("Shoppers' Core Web Vitals (OS-13, ADR-485)", () => {
  it("reads a page's report, its device from the browser, leaving out what is no measurement", () => {
    expect(
      vitalSampleOf({ t: 'product', lcp: 2380.6, inp: 96, cls: 0.0421, ttfb: 'slow' }, PHONE),
    ).toEqual({
      device: 'mobile',
      template: 'product',
      values: { lcp: 2381, inp: 96, cls: 42 },
    });
    expect(vitalSampleOf({ t: 'gift_card', fcp: 900, lcp: -1, inp: 1e9 }, LAPTOP)).toEqual({
      device: 'desktop',
      template: 'other',
      values: { fcp: 900 },
    });
    expect(vitalSampleOf({ t: 'index' }, PHONE)).toBeNull();
    expect(vitalSampleOf('lcp=1', PHONE)).toBeNull();
    expect(vitalSampleOf([1, 2], PHONE)).toBeNull();
    expect(deviceOf('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')).toBe('mobile');
    expect(deviceOf(undefined)).toBe('desktop');
  });

  it("gives a histogram's 75th percentile, its share good, and Google's rating of it", () => {
    // Three good of four: the 75th percentile is the third, 2.5 s at most.
    expect(summarize('lcp', histogramOf('lcp', [1200, 1900, 2400, 5200]))).toEqual({
      samples: 4,
      p75: 2500,
      over: false,
      good: 0.75,
      rating: 'good',
    });
    expect(summarize('lcp', histogramOf('lcp', [3100, 3900, 3900, 1000]))).toMatchObject({
      p75: 4000,
      rating: 'needs_improvement',
      good: 0.25,
    });
    expect(summarize('inp', histogramOf('inp', [80, 900, 2500, 3000]))).toMatchObject({
      p75: 2000,
      over: true,
      rating: 'poor',
    });
    // No layout shift at all is its own bucket.
    expect(summarize('cls', histogramOf('cls', [0, 0, 0, 120]))).toMatchObject({
      p75: 0,
      rating: 'good',
    });
    expect(summarize('cls', [])).toEqual({
      samples: 0,
      p75: null,
      over: false,
      good: 0,
      rating: null,
    });
  });
});

describe.skipIf(!redisUrl)("Shoppers' Core Web Vitals, in Valkey (ADR-485)", () => {
  const redis = new Redis(redisUrl ?? '', { lazyConnect: true });
  const prefix = `test-cwv-${randomBytes(4).toString('hex')}`;
  const vitals = new StorefrontVitals(redis, new StorefrontKeys(prefix));

  afterAll(async () => {
    const found = await redis.keys(`${prefix}:*`);
    if (found.length > 0) await redis.del(...found);
    redis.disconnect();
  });

  it("counts pages' measurements by day, device and kind of page, added up over days", async () => {
    const shopId = randomUUID();
    // 23:30 on 4 October in Karachi, and 00:10 on the 5th.
    const late = new Date('2026-10-04T18:30:00Z');
    const early = new Date('2026-10-04T19:10:00Z');
    const product = (values: Record<string, number>) =>
      vitalSampleOf({ t: 'product', ...values }, PHONE)!;
    await vitals.record(shopId, 'Asia/Karachi', product({ lcp: 1800, cls: 0.01 }), late);
    await vitals.record(shopId, 'Asia/Karachi', product({ lcp: 4800 }), early);
    await vitals.record(
      shopId,
      'Asia/Karachi',
      vitalSampleOf({ t: 'index', lcp: 900 }, LAPTOP)!,
      early,
    );

    const both = await vitals.histograms(shopId, ['2026-10-04', '2026-10-05', '2026-10-06']);
    expect(Object.fromEntries(both.pageViews)).toEqual({
      'mobile:product': 2,
      'desktop:index': 1,
    });
    expect(summarize('lcp', both.histograms.get('mobile:product:lcp')!)).toMatchObject({
      samples: 2,
      good: 0.5,
    });
    expect(summarize('cls', both.histograms.get('mobile:product:cls')!).samples).toBe(1);
    const first = await vitals.histograms(shopId, ['2026-10-04']);
    expect(Object.fromEntries(first.pageViews)).toEqual({ 'mobile:product': 1 });
    expect(
      await redis.ttl(new StorefrontKeys(prefix).vitals(shopId, '2026-10-04')),
    ).toBeGreaterThan(29 * 24 * 60 * 60);
  });
});
