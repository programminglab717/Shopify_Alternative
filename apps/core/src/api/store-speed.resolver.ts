import { CurrentTenant, RequireScopes, shopProfile, type TenantContext } from '@hatti/api';
import { Database } from '@hatti/db';
import {
  StorefrontVitals,
  VITALS,
  VITAL_DEVICES,
  VITAL_METRICS,
  VITAL_TEMPLATES,
  addHistograms,
  localDay,
  summarize,
  type VitalDevice,
  type VitalHistograms,
  type VitalMetric,
  type VitalSummary,
  type VitalTemplate,
} from '@hatti/storefront-data';
import { Inject } from '@nestjs/common';
import { Field, Float, Int, ObjectType, Query, Resolver, registerEnumType } from '@nestjs/graphql';
import type { Redis } from 'ioredis';
import { REDIS } from './constants.js';

// The store speed score (OS-13, ADR-485): how fast the online store was for its shoppers over
// the last 28 days, from the Core Web Vitals their browsers measured, per device as Google judges
// it, with fixes for what is slow.

/** Page views a device, or a kind of page, needs before it is scored or a fix is drawn from it. */
export const SPEED_PAGE_VIEWS_MIN = 20;

/** The metrics a score is made of: Google's Core Web Vitals. */
const CORE: readonly VitalMetric[] = ['lcp', 'inp', 'cls'];

export enum WebVital {
  LCP = 'lcp',
  INP = 'inp',
  CLS = 'cls',
  FCP = 'fcp',
  TTFB = 'ttfb',
}

registerEnumType(WebVital, {
  name: 'WebVital',
  description: 'A measurement of how fast a page was for a shopper (ADR-485).',
  valuesMap: {
    LCP: {
      description: 'Largest contentful paint: when its main content showed, in milliseconds.',
    },
    INP: {
      description:
        'Interaction to next paint: how long its slowest tap took to show, in milliseconds.',
    },
    CLS: {
      description: 'Cumulative layout shift: how much it moved about as it loaded, unitless.',
    },
    FCP: { description: 'First contentful paint: when anything first showed, in milliseconds.' },
    TTFB: {
      description: 'Time to first byte: when the storefront began answering, in milliseconds.',
    },
  },
});

export enum VitalRating {
  GOOD = 'good',
  NEEDS_IMPROVEMENT = 'needs_improvement',
  POOR = 'poor',
}

registerEnumType(VitalRating, {
  name: 'VitalRating',
  description: "Google's rating of a measurement's 75th percentile.",
});

export enum SpeedDevice {
  MOBILE = 'mobile',
  DESKTOP = 'desktop',
}

registerEnumType(SpeedDevice, {
  name: 'SpeedDevice',
  description: 'Phones and tablets, or computers, as Google counts them apart.',
});

export enum StorefrontPageKind {
  INDEX = 'index',
  PRODUCT = 'product',
  COLLECTION = 'collection',
  SEARCH = 'search',
  CART = 'cart',
  PAGE = 'page',
  BLOG = 'blog',
  ARTICLE = 'article',
  OTHER = 'other',
}

registerEnumType(StorefrontPageKind, {
  name: 'StorefrontPageKind',
  description: "A kind of the online store's pages, by its theme's template.",
});

export enum SpeedFix {
  HEAVY_FIRST_IMAGE = 'heavy_first_image',
  LAYOUT_SHIFTS = 'layout_shifts',
  SLOW_TAPS = 'slow_taps',
  SLOW_FIRST_PAINT = 'slow_first_paint',
  SLOW_SERVER = 'slow_server',
}

registerEnumType(SpeedFix, {
  name: 'SpeedFix',
  description: 'Something to do about what is slow (ADR-485).',
  valuesMap: {
    HEAVY_FIRST_IMAGE: {
      description:
        "The page's main content shows late: most often its first image or slideshow, too " +
        'large, or text in a font that loads late.',
    },
    LAYOUT_SHIFTS: {
      description:
        'The page moves as it loads: images, banners, pop-ups or apps that push content down.',
    },
    SLOW_TAPS: {
      description: 'Taps are slow to show: heavy scripts, from apps, pixels or custom code.',
    },
    SLOW_FIRST_PAINT: {
      description:
        'Nothing shows for a while after the storefront answers: fonts, styles or scripts.',
    },
    SLOW_SERVER: {
      description: "The storefront is slow to answer: Hatti's to fix, and watched.",
    },
  },
});

@ObjectType({ description: "What shoppers' browsers measured of one metric (ADR-485)." })
export class SpeedMetric {
  @Field(() => WebVital)
  metric!: WebVital;

  @Field(() => Int, { description: 'Page views that measured it.' })
  samples!: number;

  @Field(() => Float, {
    nullable: true,
    description:
      'The 75th percentile, at most this: milliseconds, or unitless for layout shift. Null ' +
      'without samples.',
  })
  p75!: number | null;

  @Field({ description: 'Whether the 75th percentile is over `p75`, the most measured apart.' })
  over!: boolean;

  @Field(() => Float, { description: 'The share of page views good by Google, 0 to 1.' })
  good!: number;

  @Field(() => VitalRating, { nullable: true })
  rating!: VitalRating | null;
}

@ObjectType({ description: "A kind of page's speed on a device." })
export class SpeedPage {
  @Field(() => StorefrontPageKind)
  kind!: StorefrontPageKind;

  @Field(() => Int)
  pageViews!: number;

  @Field(() => [SpeedMetric])
  metrics!: SpeedMetric[];
}

@ObjectType({ description: "The online store's speed on phones, or on computers." })
export class SpeedOnDevice {
  @Field(() => SpeedDevice)
  device!: SpeedDevice;

  @Field(() => Int, { description: 'Page views measured in the 28 days.' })
  pageViews!: number;

  @Field(() => Int, {
    nullable: true,
    description:
      `The share of page views good by Google, 0 to 100, averaged over the Core Web Vitals ` +
      `(largest contentful paint, interaction to next paint, layout shift); null under ` +
      `${SPEED_PAGE_VIEWS_MIN} page views.`,
  })
  score!: number | null;

  @Field(() => [SpeedMetric])
  metrics!: SpeedMetric[];

  @Field(() => [SpeedPage], { description: 'Each kind of page measured, the most viewed first.' })
  pages!: SpeedPage[];
}

@ObjectType({ description: 'Something to do about what is slow, and where.' })
export class SpeedFixFound {
  @Field(() => SpeedFix)
  fix!: SpeedFix;

  @Field(() => SpeedDevice)
  device!: SpeedDevice;

  @Field(() => StorefrontPageKind, {
    nullable: true,
    description: 'The kind of page it is slow on; null for the whole store.',
  })
  kind!: StorefrontPageKind | null;

  @Field(() => WebVital, { description: 'The measurement it is about.' })
  metric!: WebVital;

  @Field(() => VitalRating)
  rating!: VitalRating;
}

@ObjectType({
  description:
    'How fast the online store was for its shoppers over the last 28 days (OS-13, ADR-485): ' +
    "the Core Web Vitals their browsers measured, as Google's Chrome UX Report gathers them, " +
    'with fixes for what is slow.',
})
export class StoreSpeed {
  @Field(() => Int, { description: 'Page views measured in the 28 days.' })
  pageViews!: number;

  @Field(() => [SpeedOnDevice], { description: 'Phones first, then computers.' })
  devices!: SpeedOnDevice[];

  @Field(() => [SpeedFixFound], { description: 'The poorest first, then the most viewed.' })
  fixes!: SpeedFixFound[];
}

function metricOf(metric: VitalMetric, summary: VitalSummary): SpeedMetric {
  return Object.assign(new SpeedMetric(), {
    metric: metric as WebVital,
    samples: summary.samples,
    p75: summary.p75 === null ? null : metric === 'cls' ? summary.p75 / 1000 : summary.p75,
    over: summary.over,
    good: Math.round(summary.good * 10_000) / 10_000,
    rating: summary.rating as VitalRating | null,
  });
}

/** The store's speed from its histograms (ADR-485): scores per device, and fixes. */
export function storeSpeedOf({ histograms, pageViews }: VitalHistograms): StoreSpeed {
  const views = (device: VitalDevice, template: VitalTemplate) =>
    pageViews.get(`${device}:${template}`) ?? 0;
  const histogram = (device: VitalDevice, template: VitalTemplate, metric: VitalMetric) =>
    histograms.get(`${device}:${template}:${metric}`) ?? [];
  const fixes: { found: SpeedFixFound; views: number }[] = [];
  const fix = (found: Omit<SpeedFixFound, 'rating'>, summary: VitalSummary, seen: number): void => {
    if (summary.rating === 'good' || summary.rating === null) return;
    fixes.push({
      found: Object.assign(new SpeedFixFound(), {
        ...found,
        rating: summary.rating as VitalRating,
      }),
      views: seen,
    });
  };

  const devices = VITAL_DEVICES.map((device) => {
    const pages = VITAL_TEMPLATES.map((template) => ({ template, views: views(device, template) }))
      .filter((page) => page.views > 0)
      .sort((a, b) => b.views - a.views || a.template.localeCompare(b.template));
    const total = pages.reduce((sum, page) => sum + page.views, 0);
    const summaries = Object.fromEntries(
      VITAL_METRICS.map((metric) => [
        metric,
        summarize(
          metric,
          addHistograms(
            metric,
            VITAL_TEMPLATES.map((template) => histogram(device, template, metric)),
          ),
        ),
      ]),
    ) as Record<VitalMetric, VitalSummary>;
    const measured = CORE.filter((metric) => summaries[metric].samples > 0);
    const score =
      total >= SPEED_PAGE_VIEWS_MIN && measured.length > 0
        ? Math.round(
            (100 * measured.reduce((sum, metric) => sum + summaries[metric].good, 0)) /
              measured.length,
          )
        : null;

    if (total >= SPEED_PAGE_VIEWS_MIN) {
      const whole = { device: device as SpeedDevice, kind: null };
      fix({ ...whole, fix: SpeedFix.SLOW_SERVER, metric: WebVital.TTFB }, summaries.ttfb, total);
      if (summaries.ttfb.rating === 'good') {
        fix(
          { ...whole, fix: SpeedFix.SLOW_FIRST_PAINT, metric: WebVital.FCP },
          summaries.fcp,
          total,
        );
      }
    }
    const shown = pages.map(({ template, views: seen }) => {
      const pageSummaries = VITAL_METRICS.map(
        (metric) => [metric, summarize(metric, histogram(device, template, metric))] as const,
      );
      if (seen >= SPEED_PAGE_VIEWS_MIN) {
        const where = { device: device as SpeedDevice, kind: template as StorefrontPageKind };
        const of = Object.fromEntries(pageSummaries) as Record<VitalMetric, VitalSummary>;
        fix({ ...where, fix: SpeedFix.HEAVY_FIRST_IMAGE, metric: WebVital.LCP }, of.lcp, seen);
        fix({ ...where, fix: SpeedFix.LAYOUT_SHIFTS, metric: WebVital.CLS }, of.cls, seen);
        fix({ ...where, fix: SpeedFix.SLOW_TAPS, metric: WebVital.INP }, of.inp, seen);
      }
      return Object.assign(new SpeedPage(), {
        kind: template as StorefrontPageKind,
        pageViews: seen,
        metrics: pageSummaries.map(([metric, summary]) => metricOf(metric, summary)),
      });
    });
    return Object.assign(new SpeedOnDevice(), {
      device: device as SpeedDevice,
      pageViews: total,
      score,
      metrics: VITAL_METRICS.map((metric) => metricOf(metric, summaries[metric])),
      pages: shown,
    });
  });

  const severity = (rating: VitalRating) => (rating === VitalRating.POOR ? 0 : 1);
  return Object.assign(new StoreSpeed(), {
    pageViews: devices.reduce((sum, device) => sum + device.pageViews, 0),
    devices,
    fixes: fixes
      .sort((a, b) => severity(a.found.rating) - severity(b.found.rating) || b.views - a.views)
      .map(({ found }) => found),
  });
}

/** The days a summary covers, ending with `today`. */
export function speedDays(today: string): string[] {
  const end = Date.parse(`${today}T00:00:00Z`);
  return Array.from({ length: VITALS.days }, (_, back) =>
    new Date(end - back * 86_400_000).toISOString().slice(0, 10),
  );
}

@Resolver()
export class StoreSpeedResolver {
  constructor(
    private readonly db: Database,
    @Inject(REDIS) private readonly redis: Redis | null,
  ) {}

  @Query(() => StoreSpeed, {
    description:
      'How fast the online store was for its shoppers over the last 28 days, to today in the ' +
      "shop's time zone (OS-13, ADR-485): scores on phones and computers, each metric and kind " +
      'of page, and fixes.',
  })
  @RequireScopes('read_themes')
  async storeSpeed(@CurrentTenant() tenant: TenantContext): Promise<StoreSpeed> {
    const { shopId } = tenant;
    const { timezone } = await this.db.tenant(shopId, (tx) => shopProfile(tx, shopId));
    const days = speedDays(localDay(new Date(), timezone));
    const found = this.redis
      ? await new StorefrontVitals(this.redis).histograms(shopId, days)
      : { histograms: new Map(), pageViews: new Map() };
    return storeSpeedOf(found);
  }
}
