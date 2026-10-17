import type { Redis } from 'ioredis';
import { localDay } from './activity.js';
import { StorefrontKeys } from './keys.js';

// How fast a shop's storefront is for its shoppers (OS-13, ADR-485): the Core Web Vitals their
// browsers measure on its pages, as Google's Chrome UX Report gathers them. Each page a shopper
// leaves reports its largest contentful paint, interaction to next paint, cumulative layout
// shift, first contentful paint and time to first byte; the storefront counts each in a histogram
// of its day, device and kind of page. Histograms are small, add up across days, and give the
// 75th percentile Google judges a site by; 28 days of them stay in Valkey, as the report's
// window is, and nothing about a shopper is kept.

export const VITAL_METRICS = ['lcp', 'inp', 'cls', 'fcp', 'ttfb'] as const;
export type VitalMetric = (typeof VITAL_METRICS)[number];

export const VITAL_DEVICES = ['mobile', 'desktop'] as const;
export type VitalDevice = (typeof VITAL_DEVICES)[number];

/** The kinds of page measured: each a theme's template; the rest, other. */
export const VITAL_TEMPLATES = [
  'index',
  'product',
  'collection',
  'search',
  'cart',
  'page',
  'blog',
  'article',
  'other',
] as const;
export type VitalTemplate = (typeof VITAL_TEMPLATES)[number];

export const VITALS = {
  /** The days a summary looks back over, as the Chrome UX Report does. */
  days: 28,
  /** How long a day's histograms stay in Valkey. */
  keepDays: 30,
} as const;

/**
 * Google's thresholds for each metric: at most the first is good, over the second poor.
 * Milliseconds; layout shift in thousandths.
 */
export const VITAL_THRESHOLDS: Record<VitalMetric, readonly [good: number, poor: number]> = {
  lcp: [2500, 4000],
  inp: [200, 500],
  cls: [100, 250],
  fcp: [1800, 3000],
  ttfb: [800, 1800],
};

/** Each histogram's buckets' upper edges, the thresholds among them; a last bucket is over all. */
const EDGES: Record<VitalMetric, readonly number[]> = {
  lcp: [500, 1000, 1500, 2000, 2500, 3000, 3500, 4000, 5000, 6000, 8000, 10000, 15000, 20000],
  inp: [50, 100, 150, 200, 250, 300, 400, 500, 700, 1000, 1500, 2000],
  cls: [0, 25, 50, 75, 100, 150, 200, 250, 300, 400, 500, 750, 1000],
  fcp: [500, 1000, 1500, 1800, 2000, 2500, 3000, 4000, 6000, 10000],
  ttfb: [200, 400, 600, 800, 1000, 1200, 1500, 1800, 2500, 4000, 8000],
};

/** The most a measurement may be: a minute, or a layout shift of 10. */
const MAX: Record<VitalMetric, number> = {
  lcp: 60_000,
  inp: 60_000,
  cls: 10_000,
  fcp: 60_000,
  ttfb: 60_000,
};

/** One page's measurements, as a shopper's browser reported them when they left it. */
export interface VitalSample {
  device: VitalDevice;
  template: VitalTemplate;
  /** Those measured: milliseconds, layout shift in thousandths. */
  values: Partial<Record<VitalMetric, number>>;
}

/** The bucket of a metric's histogram `value` falls in. */
export function vitalBucket(metric: VitalMetric, value: number): number {
  const edges = EDGES[metric];
  const index = edges.findIndex((edge) => value <= edge);
  return index === -1 ? edges.length : index;
}

const MOBILE = /Mobi|Android|iPhone|iPad|iPod|Opera Mini|IEMobile/i;

/** Phones and tablets are mobile, as the Chrome UX Report counts them; the rest desktop. */
export function deviceOf(userAgent: string | undefined): VitalDevice {
  return MOBILE.test(userAgent ?? '') ? 'mobile' : 'desktop';
}

/**
 * A page's measurements from its script's report, `{ t, lcp, inp, cls, fcp, ttfb }`: times in
 * milliseconds, layout shift as browsers give it. Null when it is no report, or has none of them;
 * a value that is not a number in range is left out.
 */
export function vitalSampleOf(report: unknown, userAgent: string | undefined): VitalSample | null {
  if (typeof report !== 'object' || report === null || Array.isArray(report)) return null;
  const fields = report as Record<string, unknown>;
  const values: VitalSample['values'] = {};
  for (const metric of VITAL_METRICS) {
    const raw = fields[metric];
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) continue;
    const value = Math.round(metric === 'cls' ? raw * 1000 : raw);
    if (value <= MAX[metric]) values[metric] = value;
  }
  if (Object.keys(values).length === 0) return null;
  const template = VITAL_TEMPLATES.find((each) => each === fields.t) ?? 'other';
  return { device: deviceOf(userAgent), template, values };
}

/** A metric's histogram: page views by bucket. */
export type VitalHistogram = readonly number[];

/** What a histogram says of a metric. */
export interface VitalSummary {
  /** Page views that measured it. */
  samples: number;
  /** The 75th percentile, at most this: null without samples. */
  p75: number | null;
  /** Whether the 75th percentile is over the last edge, `p75`. */
  over: boolean;
  /** The share of page views good by Google's threshold, 0 to 1. */
  good: number;
  rating: 'good' | 'needs_improvement' | 'poor' | null;
}

/** The 75th percentile of a metric's histogram, its share good, and Google's rating of it. */
export function summarize(metric: VitalMetric, histogram: VitalHistogram): VitalSummary {
  const edges = EDGES[metric];
  const samples = histogram.reduce((sum, count) => sum + count, 0);
  if (samples === 0) return { samples, p75: null, over: false, good: 0, rating: null };
  const [goodAt, poorAt] = VITAL_THRESHOLDS[metric];
  let seen = 0;
  let bucket = 0;
  for (; bucket < histogram.length; bucket++) {
    seen += histogram[bucket] ?? 0;
    if (seen >= samples * 0.75) break;
  }
  const over = bucket >= edges.length;
  const p75 = over ? edges[edges.length - 1]! : edges[bucket]!;
  const goodBuckets = edges.findIndex((edge) => edge === goodAt) + 1;
  const good = histogram.slice(0, goodBuckets).reduce((sum, count) => sum + count, 0) / samples;
  const rating = over || p75 > poorAt ? 'poor' : p75 > goodAt ? 'needs_improvement' : 'good';
  return { samples, p75, over, good, rating };
}

/** Histograms by `device:template:metric`, and page views by `device:template`. */
export interface VitalHistograms {
  histograms: Map<string, number[]>;
  pageViews: Map<string, number>;
}

/** Counts pages' measurements for the storefront, and reads them for the core (ADR-485). */
export class StorefrontVitals {
  constructor(
    private readonly redis: Redis,
    private readonly keys = new StorefrontKeys(),
  ) {}

  /** A page's measurements at `at`, counted in its day in the shop's time zone. */
  async record(
    shopId: string,
    timeZone: string,
    sample: VitalSample,
    at = new Date(),
  ): Promise<void> {
    const key = this.keys.vitals(shopId, localDay(at, timeZone));
    const page = `${sample.device}:${sample.template}`;
    const pipeline = this.redis.pipeline().hincrby(key, `${page}:n`, 1);
    for (const metric of VITAL_METRICS) {
      const value = sample.values[metric];
      if (value !== undefined) {
        pipeline.hincrby(key, `${page}:${metric}:${vitalBucket(metric, value)}`, 1);
      }
    }
    const results = (await pipeline.expire(key, VITALS.keepDays * 24 * 60 * 60).exec()) ?? [];
    const failed = results.find(([error]) => error);
    if (failed) throw failed[0];
  }

  /** The histograms of `days`, "2026-10-05" in the shop's time zone, added up. */
  async histograms(shopId: string, days: readonly string[]): Promise<VitalHistograms> {
    const pipeline = this.redis.pipeline();
    for (const day of days) pipeline.hgetall(this.keys.vitals(shopId, day));
    const results = (await pipeline.exec()) ?? [];
    const histograms = new Map<string, number[]>();
    const pageViews = new Map<string, number>();
    for (const [error, counted] of results) {
      if (error) throw error;
      for (const [field, value] of Object.entries(counted as Record<string, string>)) {
        const parts = field.split(':');
        const count = Number(value);
        if (parts.length === 3 && parts[2] === 'n') {
          const page = `${parts[0]}:${parts[1]}`;
          pageViews.set(page, (pageViews.get(page) ?? 0) + count);
        } else if (parts.length === 4) {
          const metric = parts[2] as VitalMetric;
          const bucket = Number(parts[3]);
          if (!(metric in EDGES) || !Number.isInteger(bucket) || bucket > EDGES[metric].length) {
            continue;
          }
          const name = parts.slice(0, 3).join(':');
          const histogram = histograms.get(name) ?? Array<number>(EDGES[metric].length + 1).fill(0);
          histogram[bucket]! += count;
          histograms.set(name, histogram);
        }
      }
    }
    return { histograms, pageViews };
  }
}

/** Adds histograms of the same metric. */
export function addHistograms(
  metric: VitalMetric,
  histograms: readonly VitalHistogram[],
): number[] {
  const sum = Array<number>(EDGES[metric].length + 1).fill(0);
  for (const histogram of histograms) {
    histogram.forEach((count, bucket) => (sum[bucket]! += count));
  }
  return sum;
}
