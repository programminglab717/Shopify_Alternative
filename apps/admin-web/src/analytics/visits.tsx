/** The online store's visits (ANL-02, ADR-180): who is on it now, and how far a period's went. */
import { StorefrontLiveViewQuery, StorefrontSessionsQuery } from '../api/operations';
import type {
  StorefrontLiveViewData,
  StorefrontSessionCounts,
  StorefrontSessionsData,
} from '../api/types';
import { errorText } from '../i18n/errors';
import { formatCount, formatDate } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { FormSection } from '../products/product-form';
import { useAdminQuery, useShopTimezone } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Card, ErrorState, Loading } from '../ui/feedback';
import { Bars, Figure } from './figures';

/**
 * How often the live view asks again: who is on the store is who saw a page in the last five
 * minutes, and today's counts are as the storefronts have them.
 */
export const LIVE_EVERY_MS = 30_000;

/** A share as a percentage to one place, "3.1%"; a dash where there was nothing to share. */
export function percentOne(share: number | null): string {
  return share === null ? '–' : `${(share * 100).toFixed(1)}%`;
}

/** The steps a session takes towards an order, after it saw a page (Shopify's funnel). */
const STEPS: readonly {
  key: 'addedToCart' | 'reachedCheckout' | 'converted';
  label: MessageKey;
}[] = [
  { key: 'addedToCart', label: 'analytics.addedToCart' },
  { key: 'reachedCheckout', label: 'analytics.reachedCheckout' },
  { key: 'converted', label: 'analytics.converted' },
];

/** Who is on the online store now, and today's sessions so far, asked again every half minute. */
export function LiveView() {
  const { t } = useLocale();
  const query = useAdminQuery<StorefrontLiveViewData>(
    ['storefrontLiveView'],
    StorefrontLiveViewQuery,
    undefined,
    { refetchInterval: () => LIVE_EVERY_MS },
  );
  const live = query.data?.storefrontLiveView;
  const now = live?.visitorsNow ?? 0;
  return (
    <Card className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center gap-3">
        <span aria-hidden className="relative flex size-3">
          {now > 0 && (
            <span className="absolute inline-flex size-full rounded-full bg-success opacity-75 motion-safe:animate-ping" />
          )}
          <span
            className={`relative inline-flex size-3 rounded-full ${now > 0 ? 'bg-success' : 'bg-line'}`}
          />
        </span>
        <div className="flex flex-col">
          <h2 className="text-secondary">{t('analytics.live')}</h2>
          <span className="num text-[length:var(--hatti-type-title-size)] font-semibold">
            {live ? formatCount(now) : '–'}
          </span>
        </div>
      </div>
      {query.isError ? (
        <p role="alert" className="text-danger">
          {errorText(query.error, t)}
        </p>
      ) : (
        <dl className="grid grid-cols-3 gap-3">
          {(
            [
              ['analytics.sessionsToday', live?.today.sessions],
              ['analytics.addedToCart', live?.today.addedToCart],
              ['analytics.converted', live?.today.converted],
            ] as const
          ).map(([label, count]) => (
            <div key={label} className="flex flex-col">
              <dt className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
                {t(label)}
              </dt>
              <dd className="num font-semibold">
                {count === undefined ? '–' : formatCount(count)}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </Card>
  );
}

/** The steps sessions took towards an order: how many took each, and their share of sessions. */
function Funnel({ totals }: { totals: StorefrontSessionCounts }) {
  const { t } = useLocale();
  return (
    <FormSection title={t('analytics.funnel')} hint={t('analytics.funnelHint')}>
      <ul className="flex flex-col gap-3">
        {STEPS.map(({ key, label }) => {
          const count = totals[key];
          const share = totals.sessions ? count / totals.sessions : null;
          return (
            <li key={key} className="flex flex-col gap-1">
              <div className="flex items-baseline gap-3">
                <span className="min-w-0 flex-1">{t(label)}</span>
                <span className="text-secondary">
                  {t('analytics.sessionsCount', { count: formatCount(count) })}
                </span>
                <span className="num w-14 text-end font-medium">{percentOne(share)}</span>
              </div>
              <span aria-hidden className="h-2 overflow-hidden rounded-full bg-line">
                <span
                  className="block h-full rounded-full bg-primary"
                  style={{ width: `${share ? Math.max(share * 100, 1) : 0}%` }}
                />
              </span>
            </li>
          );
        })}
      </ul>
    </FormSection>
  );
}

/**
 * The online store's sessions over the period the page shows, against the period as long before:
 * how many, their conversion rate, how far they went towards an order, and day by day (week by
 * week over 90 days).
 */
export function Visits({
  from,
  before,
  previousFrom,
  interval,
}: {
  from: string;
  before: string;
  previousFrom: string;
  interval: 'DAY' | 'WEEK';
}) {
  const { t, locale } = useLocale();
  const timezone = useShopTimezone();
  const query = useAdminQuery<StorefrontSessionsData>(
    ['storefrontSessions'],
    StorefrontSessionsQuery,
    { from, before, previousFrom, interval },
  );

  let body;
  if (query.isPending) body = <Loading label={t('state.loading')} />;
  else if (query.isError) {
    body = (
      <ErrorState
        message={errorText(query.error, t)}
        action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
      />
    );
  } else {
    const { totals, periods } = query.data.storefrontSessions;
    const earlier = query.data.previous.totals;
    body =
      totals.sessions === 0 && earlier.sessions === 0 ? (
        <Card>
          <p className="p-4 text-secondary">{t('analytics.noVisits')}</p>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3">
            <Figure
              label="analytics.sessions"
              now={totals.sessions}
              before={earlier.sessions}
              shown={formatCount(totals.sessions)}
            />
            <Figure
              label="analytics.conversionRate"
              now={totals.conversionRate ?? 0}
              before={earlier.conversionRate ?? 0}
              shown={percentOne(totals.conversionRate)}
            />
          </div>
          <Funnel totals={totals} />
          <Bars
            title={t('analytics.sessionsOverTime')}
            bars={periods.map((period) => ({
              start: period.start,
              value: period.sessions.sessions,
              label: t('analytics.sessionsBar', {
                date: formatDate(period.start, timezone, locale),
                count: formatCount(period.sessions.sessions),
                converted: formatCount(period.sessions.converted),
              }),
            }))}
          />
        </>
      );
  }

  return (
    <section aria-labelledby="analytics-visits" className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 id="analytics-visits" className="font-semibold">
          {t('analytics.visits')}
        </h2>
        <p className="text-secondary">{t('analytics.visitsHint')}</p>
      </div>
      {body}
    </section>
  );
}
