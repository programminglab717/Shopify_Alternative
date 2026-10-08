import type { Locale } from './locale';

// Numbers, money, phones and dates as the design system says (docs/design/01 §3): Western digits
// in both languages, "Rs 12,500", "0300 1234567", "27 Sep 2026, 3:05 pm" in the shop's time zone.

const grouped = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const groupedPaisa = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** A count, grouped: "1,250". */
export function formatCount(value: number): string {
  return grouped.format(value);
}

/**
 * An amount as the API gives it, a decimal string such as "4850.00", in its currency: "Rs 4,850",
 * paisa shown only when there are some ("Rs 4,850.50"). Other currencies keep their code.
 */
export function formatMoney(amount: string, currency = 'PKR'): string {
  const value = Number(amount);
  if (!Number.isFinite(value)) return amount;
  const whole = Number.isInteger(value);
  const digits = (whole ? grouped : groupedPaisa).format(Math.abs(value));
  const sign = value < 0 ? '-' : '';
  return currency === 'PKR' ? `${sign}Rs ${digits}` : `${sign}${currency} ${digits}`;
}

/** A Pakistani mobile kept as "+923001234567", shown as "0300 1234567"; others as they are. */
export function formatPhone(phone: string): string {
  const match = /^\+92(3\d{2})(\d{7})$/.exec(phone);
  return match ? `0${match[1]} ${match[2]}` : phone;
}

function dateLocale(locale: Locale): string {
  return locale === 'ur' ? 'ur-PK-u-nu-latn' : 'en-GB';
}

/** "27 Sep 2026, 3:05 pm" in the shop's time zone. */
export function formatDateTime(iso: string, timeZone: string, locale: Locale): string {
  return new Intl.DateTimeFormat(dateLocale(locale), {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone,
  }).format(new Date(iso));
}

/** "27 Sep 2026" in the shop's time zone. */
export function formatDate(iso: string, timeZone: string, locale: Locale): string {
  return new Intl.DateTimeFormat(dateLocale(locale), {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone,
  }).format(new Date(iso));
}

/** "2 hours ago", or the date once it is more than a week old. */
export function formatRelative(
  iso: string,
  timeZone: string,
  locale: Locale,
  now: Date = new Date(),
): string {
  const seconds = Math.round((new Date(iso).getTime() - now.getTime()) / 1000);
  const abs = Math.abs(seconds);
  if (abs >= 7 * 86_400) return formatDate(iso, timeZone, locale);
  const relative = new Intl.RelativeTimeFormat(dateLocale(locale), { numeric: 'auto' });
  if (abs < 60) return relative.format(0, 'second');
  if (abs < 3_600) return relative.format(Math.trunc(seconds / 60), 'minute');
  if (abs < 86_400) return relative.format(Math.trunc(seconds / 3_600), 'hour');
  return relative.format(Math.trunc(seconds / 86_400), 'day');
}
