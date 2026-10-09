import { TrendingDown, TrendingUp } from 'lucide-react';
import { formatDate } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { FormSection } from '../products/product-form';
import { useShopTimezone } from '../shell/shop-context';
import { Card } from '../ui/feedback';

/** How much `now` differs from `before`, as a whole percentage; null where before was nothing. */
export function change(now: number, before: number): number | null {
  if (before === 0) return null;
  return Math.round(((now - before) / before) * 100);
}

/** A figure of the period, and how much more or less it is than the period before. */
export function Figure({
  label,
  now,
  before,
  shown,
}: {
  label: MessageKey;
  now: number;
  before: number;
  shown: string;
}) {
  const { t } = useLocale();
  const delta = change(now, before);
  return (
    <Card className="flex flex-col gap-1 p-4">
      <span className="text-secondary">{t(label)}</span>
      <span className="num text-[length:var(--hatti-type-title-size)] font-semibold">{shown}</span>
      {delta !== null && (
        <span
          className={`flex items-center gap-1 text-[length:var(--hatti-type-body-sm-size)] ${
            delta >= 0 ? 'text-success' : 'text-danger'
          }`}
        >
          {delta >= 0 ? (
            <TrendingUp aria-hidden className="size-4" />
          ) : (
            <TrendingDown aria-hidden className="size-4" />
          )}
          {t(delta >= 0 ? 'analytics.up' : 'analytics.down', { percent: Math.abs(delta) })}
        </span>
      )}
    </Card>
  );
}

/** A day's or week's bar: when it starts, how tall it stands, and what it says it was. */
export interface Bar {
  start: string;
  value: number;
  label: string;
}

/** Days or weeks as bars, each saying what it was to a screen reader. */
export function Bars({ title, bars }: { title: string; bars: readonly Bar[] }) {
  const { locale } = useLocale();
  const timezone = useShopTimezone();
  const most = Math.max(...bars.map((bar) => bar.value), 1);
  const first = bars[0];
  const last = bars.at(-1);
  return (
    <FormSection title={title}>
      <ul className="flex h-40 items-end gap-px" aria-label={title}>
        {bars.map((bar) => (
          <li
            key={bar.start}
            aria-label={bar.label}
            title={bar.label}
            className="flex h-full min-w-0 flex-1 items-end"
          >
            <span
              className={`w-full rounded-t-sm ${bar.value > 0 ? 'bg-primary' : 'bg-line'}`}
              style={{ height: `${Math.max((bar.value / most) * 100, bar.value > 0 ? 2 : 1)}%` }}
            />
          </li>
        ))}
      </ul>
      {first && last && (
        <div className="flex justify-between text-secondary text-[length:var(--hatti-type-body-sm-size)]">
          <span>{formatDate(first.start, timezone, locale)}</span>
          <span>{formatDate(last.start, timezone, locale)}</span>
        </div>
      )}
    </FormSection>
  );
}
