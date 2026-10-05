// The email a scheduled export goes in (ORD-11, ADR-183): the orders placed in the period that
// ended, attached, to the member of staff who scheduled it, in their own language (ADR-194).

import type { ExportLayoutValue, OrderExportFile } from './order-export.service.js';

export const EXPORT_FREQUENCIES = ['daily', 'weekly', 'monthly'] as const;
export type ExportFrequencyValue = (typeof EXPORT_FREQUENCIES)[number];

/** A period of a schedule's, by its days in the shop's time zone. */
export interface ExportPeriod {
  /** "2026-10-04". */
  firstDay: string;
  lastDay: string;
  /** The day after its last: its orders were placed before this one began. */
  endDay: string;
}

/** An email with a file attached. */
export interface ScheduledExportEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
  attachment: OrderExportFile;
}

/**
 * Sends a scheduled export's email at once, as the host application can: through Amazon SES, or
 * to the log in development. `retry` for what may go later, as when the service is busy;
 * `failed` for what never will.
 */
export abstract class ScheduledExportSender {
  abstract send(email: ScheduledExportEmail): Promise<'sent' | 'retry' | 'failed'>;
}

/** The period of `frequency` that ends on `endDay`: the day, week or month before it. */
export function exportPeriod(frequency: ExportFrequencyValue, endDay: string): ExportPeriod {
  const end = new Date(`${endDay}T00:00:00Z`);
  const first = new Date(end);
  if (frequency === 'monthly') first.setUTCMonth(first.getUTCMonth() - 1);
  else first.setUTCDate(first.getUTCDate() - (frequency === 'weekly' ? 7 : 1));
  const last = new Date(end);
  last.setUTCDate(last.getUTCDate() - 1);
  return {
    firstDay: first.toISOString().slice(0, 10),
    lastDay: last.toISOString().slice(0, 10),
    endDay,
  };
}

/**
 * A scheduled export's file name, for its period rather than the day it was made:
 * "orders-2026-10-04.xlsx", "orders-2026-09-28-to-2026-10-04.csv", "order-items-2026-09.xlsx".
 */
export function periodFilename(
  frequency: ExportFrequencyValue,
  layout: ExportLayoutValue,
  period: ExportPeriod,
  extension: string,
): string {
  const prefix = layout === 'orders' ? 'orders' : 'order-items';
  const name =
    frequency === 'daily'
      ? period.firstDay
      : frequency === 'weekly'
        ? `${period.firstDay}-to-${period.lastDay}`
        : period.firstDay.slice(0, 7);
  return `${prefix}-${name}.${extension}`;
}

/** What a scheduled export's email is in: its member's own language (ADR-194). */
export type ExportEmailLanguage = 'en' | 'ur';

/** The email carrying a scheduled export to `to`, its file attached, in `language`. */
export function scheduledExportEmail(input: {
  to: string;
  /** The member's name. */
  name: string;
  shop: string;
  frequency: ExportFrequencyValue;
  layout: ExportLayoutValue;
  period: ExportPeriod;
  /** Rows in the file, its header aside. */
  rows: number;
  file: OrderExportFile;
  language: ExportEmailLanguage;
}): ScheduledExportEmail {
  const shop = oneLine(input.shop);
  const name = oneLine(input.name);
  const { filename } = input.file;
  const { label, placed } = periodWords(input.frequency, input.period, input.language);
  const urdu = input.language === 'ur';
  let paragraphs: string[];
  if (urdu) {
    const noun = input.layout === 'orders' ? 'آرڈر' : 'آئٹم';
    const count =
      input.rows === 0
        ? `کوئی ${noun} نہیں`
        : `${input.rows} ${input.rows === 1 ? noun : `${noun}ز`}`;
    const every = { daily: 'روز', weekly: 'ہفتے', monthly: 'مہینے' }[input.frequency];
    paragraphs = [
      `السلام علیکم ${name}،`,
      `${shop} پر ${placed} دیے گئے آرڈرز: ${count}، منسلک فائل ${filename} میں۔`,
      `آپ کو یہ ہر ${every} ملتی ہے کیونکہ آپ نے اسے ہٹی میں شیڈول کیا ہے۔ اسے روکنے کے لیے ` +
        'ہٹی کے ایڈمن میں شیڈول حذف کریں۔',
    ];
  } else {
    const noun = input.layout === 'orders' ? 'order' : 'line item';
    const count =
      input.rows === 0 ? `no ${noun}s` : `${input.rows} ${input.rows === 1 ? noun : `${noun}s`}`;
    const every = { daily: 'day', weekly: 'week', monthly: 'month' }[input.frequency];
    paragraphs = [
      `Assalam o alaikum ${name},`,
      `${shop}'s orders placed ${placed}: ${count}, in the attached ${filename}.`,
      `You get this every ${every} because you scheduled it in Hatti. To stop it, delete the ` +
        "schedule in Hatti's admin.",
    ];
  }
  return {
    to: input.to,
    subject: urdu ? `${shop} کے آرڈرز: ${label}` : `Orders from ${shop}: ${label}`,
    text: paragraphs.join('\n\n'),
    html:
      `<!doctype html><html lang="${input.language}"${urdu ? ' dir="rtl"' : ''}>` +
      '<body style="font-family:system-ui,sans-serif;line-height:1.5;color:#1f2933">' +
      paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join('') +
      '</body></html>',
    attachment: input.file,
  };
}

/**
 * "4 Oct 2026", "28 Sep to 4 Oct 2026", "September 2026", or in Urdu "4 اکتوبر، 2026": and how a
 * sentence says so.
 */
function periodWords(
  frequency: ExportFrequencyValue,
  period: ExportPeriod,
  language: ExportEmailLanguage,
): { label: string; placed: string } {
  const urdu = language === 'ur';
  const locale = urdu ? 'ur-PK' : 'en-GB';
  const first = new Date(`${period.firstDay}T00:00:00Z`);
  const last = new Date(`${period.lastDay}T00:00:00Z`);
  const day = (date: Date, year: boolean) =>
    new Intl.DateTimeFormat(locale, {
      timeZone: 'UTC',
      day: 'numeric',
      month: 'short',
      ...(year ? { year: 'numeric' } : {}),
    }).format(date);
  if (frequency === 'daily') {
    const label = day(first, true);
    return { label, placed: urdu ? `${label} کو` : `on ${label}` };
  }
  if (frequency === 'weekly') {
    const sameYear = first.getUTCFullYear() === last.getUTCFullYear();
    if (urdu) {
      const label = `${day(first, !sameYear)} سے ${day(last, true)} تک`;
      return { label, placed: label };
    }
    const label = `${day(first, !sameYear)} to ${day(last, true)}`;
    return { label, placed: `from ${label}` };
  }
  const label = new Intl.DateTimeFormat(locale, {
    timeZone: 'UTC',
    month: 'long',
    year: 'numeric',
  }).format(first);
  return { label, placed: urdu ? `${label} میں` : `in ${label}` };
}

/** A name on one line, as a subject or a sentence quotes it. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
