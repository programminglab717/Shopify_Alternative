import 'reflect-metadata';
import { addHistograms, vitalBucket, type VitalMetric } from '@hatti/storefront-data';
import { describe, expect, it } from 'vitest';
import { speedDays, storeSpeedOf } from './store-speed.resolver.js';

/** Histograms and page views from pages' measurements, keyed as Valkey keeps them. */
function measured(pages: { page: string; values: Partial<Record<VitalMetric, number>> }[]) {
  const histograms = new Map<string, number[]>();
  const pageViews = new Map<string, number>();
  for (const { page, values } of pages) {
    pageViews.set(page, (pageViews.get(page) ?? 0) + 1);
    for (const [metric, value] of Object.entries(values) as [VitalMetric, number][]) {
      const name = `${page}:${metric}`;
      const histogram = histograms.get(name) ?? addHistograms(metric, []);
      histogram[vitalBucket(metric, value)]! += 1;
      histograms.set(name, histogram);
    }
  }
  return { histograms, pageViews };
}

const times = <T>(count: number, make: (index: number) => T): T[] =>
  Array.from({ length: count }, (_, index) => make(index));

describe('The store speed score (OS-13, ADR-485)', () => {
  it('scores each device by its share of good page views, and draws fixes from what is slow', () => {
    const speed = storeSpeedOf(
      measured([
        // Phones: a slow server, home pages that shift, collections whose taps are slow.
        ...times(25, () => ({
          page: 'mobile:index',
          values: { lcp: 2000, cls: 300, inp: 100, ttfb: 1900, fcp: 1000 },
        })),
        ...times(25, (index) => ({
          page: 'mobile:collection',
          values: { lcp: 2000, cls: 0, inp: index < 10 ? 100 : 350, ttfb: 1900 },
        })),
        // Computers: fine, but nothing shows for a while.
        ...times(20, () => ({
          page: 'desktop:product',
          values: { lcp: 2400, cls: 0, inp: 40, ttfb: 300, fcp: 2500 },
        })),
        // Too few views of carts to draw a fix from.
        ...times(3, () => ({ page: 'desktop:cart', values: { lcp: 9000 } })),
      ]),
    );
    const [mobile, desktop] = speed.devices;
    // Largest paint good on all, layout shift on half, taps on 35 of 50.
    expect([mobile!.score, mobile!.pageViews]).toEqual([Math.round((100 + 50 + 70) / 3), 50]);
    expect(mobile!.pages.map((page) => [page.kind, page.pageViews])).toEqual([
      ['collection', 25],
      ['index', 25],
    ]);
    expect(desktop!.score).toBe(Math.round((100 * (20 / 23) + 100 + 100) / 3));
    expect(speed.fixes.map((fix) => [fix.fix, fix.device, fix.kind, fix.rating])).toEqual([
      ['slow_server', 'mobile', null, 'poor'],
      ['layout_shifts', 'mobile', 'index', 'poor'],
      ['slow_taps', 'mobile', 'collection', 'needs_improvement'],
      ['slow_first_paint', 'desktop', null, 'needs_improvement'],
    ]);
  });

  it('scores nothing without enough views, and covers the 28 days to today', () => {
    const speed = storeSpeedOf(measured([{ page: 'mobile:product', values: { lcp: 9000 } }]));
    expect(speed.pageViews).toBe(1);
    expect(speed.devices.map((device) => device.score)).toEqual([null, null]);
    expect(speed.fixes).toEqual([]);
    const days = speedDays('2026-03-01');
    expect([days.length, days[0], days[1], days.at(-1)]).toEqual([
      28,
      '2026-03-01',
      '2026-02-28',
      '2026-02-02',
    ]);
  });
});
