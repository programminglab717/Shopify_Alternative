import { useMemo } from 'react';
import { useLocale } from '../i18n/locale';
import { useShopTimezone } from '../shell/shop-context';

const DAY_MS = 86_400_000;
/** The periods analytics shows, in days. */
export const PERIODS = [7, 30, 90] as const;
export type Days = (typeof PERIODS)[number];

/** The start of the day `daysAgo` days before today, in the shop's time zone. */
export function startOfDay(timeZone: string, daysAgo: number, now = new Date()): Date {
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  const offset =
    new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
      .formatToParts(now)
      .find((part) => part.type === 'timeZoneName')
      ?.value.replace('GMT', '') || 'Z';
  return new Date(Date.parse(`${date}T00:00:00${offset}`) - daysAgo * DAY_MS);
}

/**
 * The last `days` days: whole days in the shop's time zone, today's included, and as many before
 * them, for the period to compare with.
 */
export function usePeriod(days: Days) {
  const timezone = useShopTimezone();
  return useMemo(
    () => ({
      from: startOfDay(timezone, days - 1).toISOString(),
      before: startOfDay(timezone, -1).toISOString(),
      previousFrom: startOfDay(timezone, 2 * days - 1).toISOString(),
    }),
    [days, timezone],
  );
}

/** The periods to choose from, as tabs. */
export function PeriodTabs({ days, onChange }: { days: Days; onChange: (days: Days) => void }) {
  const { t } = useLocale();
  return (
    <div role="tablist" className="flex gap-2">
      {PERIODS.map((each) => (
        <button
          key={each}
          type="button"
          role="tab"
          aria-selected={days === each}
          onClick={() => onChange(each)}
          className={`min-h-10 rounded-full border px-4 ${
            days === each ? 'border-primary bg-primary text-on-primary' : 'border-line'
          }`}
        >
          {t('analytics.days', { count: each })}
        </button>
      ))}
    </div>
  );
}
