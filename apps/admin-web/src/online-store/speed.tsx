import { CircleAlert, CircleCheck, Gauge, Laptop, Smartphone, TriangleAlert } from 'lucide-react';
import { StoreSpeedQuery } from '../api/operations';
import type {
  SpeedDeviceValue,
  SpeedMetricValue,
  StoreSpeedData,
  VitalRatingValue,
  WebVitalValue,
} from '../api/types';
import { errorText } from '../i18n/errors';
import { formatCount } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import { useAdminQuery } from '../shell/shop-context';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card, EmptyState, ErrorState, Loading } from '../ui/feedback';

const RATINGS = {
  GOOD: { colour: 'delivered', icon: CircleCheck },
  NEEDS_IMPROVEMENT: { colour: 'needsConfirmation', icon: TriangleAlert },
  POOR: { colour: 'deliveryIssue', icon: CircleAlert },
} as const satisfies Record<VitalRatingValue, unknown>;

const DEVICE_ICONS = { MOBILE: Smartphone, DESKTOP: Laptop } as const satisfies Record<
  SpeedDeviceValue,
  unknown
>;

/** The Core Web Vitals, which make the score, then the two that explain them. */
const SHOWN: readonly WebVitalValue[] = ['LCP', 'INP', 'CLS', 'FCP', 'TTFB'];

/** A measurement as people read it: seconds past one, milliseconds under, layout shift bare. */
function useMeasure() {
  const { t } = useLocale();
  return (metric: SpeedMetricValue): string => {
    if (metric.p75 === null) return t('speed.notMeasured');
    const value =
      metric.metric === 'CLS'
        ? String(metric.p75)
        : metric.p75 >= 1000
          ? t('speed.seconds', { value: String(metric.p75 / 1000) })
          : t('speed.milliseconds', { value: String(metric.p75) });
    return metric.over ? t('speed.over', { value }) : value;
  };
}

/**
 * The store speed score (OS-13, ADR-485): how fast the online store was for its shoppers over the
 * last 28 days, from what their browsers measured, on phones and on computers, each Core Web
 * Vital with Google's rating, and what to do about what is slow.
 */
export function SpeedTab() {
  const { t } = useLocale();
  const measure = useMeasure();
  const query = useAdminQuery<StoreSpeedData>(['storeSpeed'], StoreSpeedQuery);

  if (query.isPending) return <Loading label={t('state.loading')} />;
  if (query.isError) {
    return (
      <ErrorState
        message={errorText(query.error, t)}
        action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
      />
    );
  }
  const speed = query.data.storeSpeed;
  if (speed.pageViews === 0) {
    return <EmptyState title={t('speed.none')} body={t('speed.noneHint')} />;
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-secondary">{t('speed.intro')}</p>
      {speed.devices
        .filter((device) => device.pageViews > 0)
        .map((device) => {
          const Icon = DEVICE_ICONS[device.device];
          return (
            <Card key={device.device} className="flex flex-col gap-3 p-4">
              <h2 className="flex items-center gap-2 font-semibold">
                <Icon aria-hidden className="size-5 text-secondary" />
                {t(`speed.device.${device.device}`)}
              </h2>
              {device.score === null ? (
                <p className="text-secondary">
                  {t('speed.tooFew', { count: formatCount(device.pageViews) })}
                </p>
              ) : (
                <p className="flex items-baseline gap-2">
                  <Gauge aria-hidden className="size-5 self-center text-secondary" />
                  <span className="text-[length:var(--hatti-type-display-size)] font-semibold">
                    {t('speed.score', { score: device.score })}
                  </span>
                  <span className="text-secondary">
                    {t('speed.pageViews', { count: formatCount(device.pageViews) })}
                  </span>
                </p>
              )}
              <ul className="flex flex-col divide-y divide-line">
                {SHOWN.map((name) => {
                  const metric = device.metrics.find((each) => each.metric === name);
                  if (!metric || metric.samples === 0) return null;
                  const rating = metric.rating && RATINGS[metric.rating];
                  return (
                    <li key={name} className="flex flex-wrap items-center gap-2 py-2">
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="font-medium">{t(`speed.metric.${name}`)}</span>
                        <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
                          {t('speed.good', { share: Math.round(metric.good * 100) })}
                        </span>
                      </span>
                      <span className="font-medium" dir="ltr">
                        {measure(metric)}
                      </span>
                      {rating && metric.rating && (
                        <Badge
                          colour={rating.colour}
                          icon={rating.icon}
                          label={t(`speed.rating.${metric.rating}`)}
                        />
                      )}
                    </li>
                  );
                })}
              </ul>
            </Card>
          );
        })}
      <h2 className="font-semibold">{t('speed.fixes')}</h2>
      {speed.fixes.length === 0 ? (
        <p className="text-secondary">{t('speed.noFixes')}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {speed.fixes.map((fix) => {
            const rating = RATINGS[fix.rating];
            return (
              <li key={`${fix.fix}-${fix.device}-${fix.kind ?? 'all'}`}>
                <Card className="flex flex-col gap-2 p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-medium">{t(`speed.fix.${fix.fix}`)}</h3>
                    <Badge
                      colour={rating.colour}
                      icon={rating.icon}
                      label={t(`speed.rating.${fix.rating}`)}
                    />
                  </div>
                  <p className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
                    {fix.kind
                      ? t('speed.where', {
                          device: t(`speed.device.${fix.device}`),
                          kind: t(`speed.kind.${fix.kind}`),
                        })
                      : t(`speed.device.${fix.device}`)}
                  </p>
                  <p>{t(`speed.fixHint.${fix.fix}`)}</p>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
