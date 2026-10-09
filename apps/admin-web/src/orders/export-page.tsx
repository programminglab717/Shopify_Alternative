import { Link, useSearch } from '@tanstack/react-router';
import { ArrowLeft, CalendarClock, Download, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import {
  OrderExportScheduleCreateMutation,
  OrderExportScheduleDeleteMutation,
  OrderExportSchedulesQuery,
  OrdersExportMutation,
} from '../api/operations';
import type {
  ExportSchedule,
  OrderExportFormat,
  OrderExportFrequency,
  OrderExportLayout,
  OrderExportScheduleCreateData,
  OrderExportScheduleDeleteData,
  OrderExportSchedulesData,
  OrdersExportData,
} from '../api/types';
import { useMe } from '../auth/context';
import { useRecentAuthentication } from '../auth/confirm-identity';
import type { StaffRole } from '../auth/session';
import { errorText } from '../i18n/errors';
import { formatCount, formatDate, formatDateTime, startOfDayIn } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { FormSection, problemText } from '../products/product-form';
import { SelectField } from '../settings/settings-form';
import { useAdminMutation, useAdminQuery, useShop, useShopTimezone } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, EmptyState } from '../ui/feedback';
import { TextField } from '../ui/field';
import type { OrdersSearch } from './orders-page';
import { STAGES } from './stage';

/** Those who take the shop's orders out as files (ORD-11): owners, managers and accountants. */
export const EXPORTS_ORDERS: readonly StaffRole[] = ['owner', 'manager', 'accountant'];

const FORMATS: readonly OrderExportFormat[] = ['XLSX', 'CSV'];
const LAYOUTS: readonly OrderExportLayout[] = ['ORDERS', 'LINE_ITEMS'];
const FREQUENCIES: readonly OrderExportFrequency[] = ['DAILY', 'WEEKLY', 'MONTHLY'];

/** A day after `date` (`2026-10-31`), as a date field writes it. */
function dayAfter(date: string): string {
  const next = new Date(`${date}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

/** A file the core sent, its bytes in base64, saved by the browser under its own name. */
function save(file: { content: string; contentType: string; filename: string }) {
  const bytes = Uint8Array.from(atob(file.content), (char) => char.charCodeAt(0));
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([bytes], { type: file.contentType }));
  link.download = file.filename;
  link.click();
  URL.revokeObjectURL(link.href);
}

/** The list's search as the query language writes it, for a schedule, which takes no stage. */
export function queryOf(search: OrdersSearch): string {
  return [search.stage && `stage:${search.stage.toLowerCase()}`, search.q]
    .filter(Boolean)
    .join(' ');
}

/** What the export holds, in words: the list's tab and search, or every order. */
function Which({ search }: { search: OrdersSearch }) {
  const { t } = useLocale();
  const stage = search.stage ? t(STAGES[search.stage].label) : null;
  if (stage && search.q) return <>{t('exports.whichBoth', { stage, q: search.q })}</>;
  if (stage) return <>{t('exports.whichStage', { stage })}</>;
  if (search.q) return <>{t('exports.whichSearch', { q: search.q })}</>;
  return <>{t('exports.whichAll')}</>;
}

/** The file's shape: Excel or CSV, a row per order or per item. */
function Shape({
  format,
  layout,
  onFormat,
  onLayout,
}: {
  format: OrderExportFormat;
  layout: OrderExportLayout;
  onFormat: (format: OrderExportFormat) => void;
  onLayout: (layout: OrderExportLayout) => void;
}) {
  const { t } = useLocale();
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <SelectField<OrderExportFormat>
        label={t('exports.format')}
        value={format}
        options={FORMATS.map((each) => ({
          value: each,
          label: t(`exports.format.${each}` as MessageKey),
        }))}
        onChange={onFormat}
      />
      <SelectField<OrderExportLayout>
        label={t('exports.layout')}
        value={layout}
        options={LAYOUTS.map((each) => ({
          value: each,
          label: t(`exports.layout.${each}` as MessageKey),
        }))}
        onChange={onLayout}
      />
    </div>
  );
}

/** The orders the list shows, between two days if asked, saved as a file now. */
function DownloadNow({ search }: { search: OrdersSearch }) {
  const { t } = useLocale();
  const timezone = useShopTimezone();
  const exporting = useAdminMutation<OrdersExportData, Record<string, unknown>>(
    OrdersExportMutation,
  );
  const { run, panel } = useRecentAuthentication();
  const [format, setFormat] = useState<OrderExportFormat>('XLSX');
  const [layout, setLayout] = useState<OrderExportLayout>('ORDERS');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<number | null>(null);

  const download = () => {
    setProblem(null);
    setDone(null);
    void run(
      async () => {
        const { ordersExport } = await exporting.mutateAsync({
          format,
          layout,
          query: search.q ?? null,
          stage: search.stage ?? null,
          // Days in the shop's time zone: from the first's start to the last's end.
          placedFrom: from ? startOfDayIn(from, timezone) : null,
          placedBefore: to ? startOfDayIn(dayAfter(to), timezone) : null,
        });
        const error = ordersExport.userErrors[0];
        if (error || !ordersExport.file) {
          setProblem(error ? problemText(error, t) : t('state.error'));
          return;
        }
        save(ordersExport.file);
        setDone(ordersExport.rowCount);
      },
      (failure) => setProblem(errorText(failure, t)),
    );
  };

  return (
    <FormSection title={t('exports.now')} hint={t('exports.nowHint')}>
      <p className="font-medium">
        <Which search={search} />
      </p>
      <Shape format={format} layout={layout} onFormat={setFormat} onLayout={setLayout} />
      <div className="grid gap-3 md:grid-cols-2">
        <TextField
          label={t('exports.from')}
          type="date"
          ltr
          value={from}
          onChange={(event) => setFrom(event.target.value)}
        />
        <TextField
          label={t('exports.to')}
          type="date"
          ltr
          value={to}
          onChange={(event) => setTo(event.target.value)}
        />
      </div>
      {panel}
      {problem && <Alert tone="danger">{problem}</Alert>}
      {done !== null && (
        <Alert tone="success">{t('exports.done', { count: formatCount(done) })}</Alert>
      )}
      <Button
        className="self-start"
        busy={exporting.isPending}
        icon={<Download aria-hidden className="size-5" />}
        onClick={download}
      >
        {t('exports.download')}
      </Button>
    </FormSection>
  );
}

/** One scheduled export: how often, at what hour, of which orders, and when it goes next. */
function ScheduleRow({ schedule, mine }: { schedule: ExportSchedule; mine: boolean }) {
  const { t, locale } = useLocale();
  const timezone = useShopTimezone();
  const remove = useAdminMutation<OrderExportScheduleDeleteData, { id: string }>(
    OrderExportScheduleDeleteMutation,
  );
  const [problem, setProblem] = useState<string | null>(null);
  const onDelete = async () => {
    setProblem(null);
    try {
      const { orderExportScheduleDelete } = await remove.mutateAsync({ id: schedule.id });
      const error = orderExportScheduleDelete.userErrors[0];
      if (error) setProblem(problemText(error, t));
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };
  return (
    <li className="flex flex-col gap-1 py-3">
      <span className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">
          {t(`exports.every.${schedule.frequency}` as MessageKey, {
            hour: String(schedule.hour).padStart(2, '0'),
          })}{' '}
          · {t(`exports.format.${schedule.format}` as MessageKey)} ·{' '}
          {t(`exports.layout.${schedule.layout}` as MessageKey)}
        </span>
        <Button
          variant="danger"
          aria-label={t('exports.stop')}
          busy={remove.isPending}
          icon={<Trash2 aria-hidden className="size-5" />}
          onClick={() => void onDelete()}
        />
      </span>
      <span className="text-secondary">
        {schedule.query ? (
          <span dir="ltr" className="num">
            {schedule.query}
          </span>
        ) : (
          t('exports.whichAll')
        )}
        {' · '}
        {mine ? t('exports.toYou') : t('exports.toOther')}
      </span>
      <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
        {t('exports.next', {
          date: formatDateTime(schedule.nextSendAt, timezone, locale),
          first: formatDate(`${schedule.nextPeriodFirstDay}T12:00:00Z`, 'UTC', locale),
          last: formatDate(`${schedule.nextPeriodLastDay}T12:00:00Z`, 'UTC', locale),
        })}
      </span>
      {schedule.lastError && <Alert tone="warning">{schedule.lastError}</Alert>}
      {problem && <Alert tone="danger">{problem}</Alert>}
    </li>
  );
}

/** Scheduled exports: the list's orders of each day, week or month, emailed as a file. */
function Scheduled({ search }: { search: OrdersSearch }) {
  const { t } = useLocale();
  const shopId = useShop().id;
  const me = useMe().data?.user;
  const schedules = useAdminQuery<OrderExportSchedulesData>(
    ['orderExportSchedules'],
    OrderExportSchedulesQuery,
  );
  const create = useAdminMutation<OrderExportScheduleCreateData, Record<string, unknown>>(
    OrderExportScheduleCreateMutation,
  );
  const { run, panel } = useRecentAuthentication();
  const [frequency, setFrequency] = useState<OrderExportFrequency>('WEEKLY');
  const [hour, setHour] = useState('8');
  const [format, setFormat] = useState<OrderExportFormat>('XLSX');
  const [layout, setLayout] = useState<OrderExportLayout>('ORDERS');
  const [problem, setProblem] = useState<string | null>(null);
  const [made, setMade] = useState(false);

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    setProblem(null);
    setMade(false);
    void run(
      async () => {
        const { orderExportScheduleCreate } = await create.mutateAsync({
          input: { frequency, hour: Number(hour), format, layout, query: queryOf(search) || null },
        });
        const error = orderExportScheduleCreate.userErrors[0];
        if (error) setProblem(problemText(error, t));
        else setMade(true);
      },
      (failure) => setProblem(errorText(failure, t)),
    );
  };

  const list = schedules.data?.orderExportSchedules ?? [];
  return (
    <FormSection title={t('exports.scheduled')} hint={t('exports.scheduledHint')}>
      {list.length > 0 && (
        <ul aria-label={t('exports.scheduled')} className="flex flex-col divide-y divide-line">
          {list.map((schedule) => (
            <ScheduleRow
              key={schedule.id}
              schedule={schedule}
              mine={schedule.staffMemberId === me?.id}
            />
          ))}
        </ul>
      )}
      {me && (!me.email || me.emailVerified === false) ? (
        <Alert tone="warning">
          {t('exports.noEmail')}{' '}
          <Link to="/$shopId/account" params={{ shopId }} className="underline">
            {t('account.title')}
          </Link>
        </Alert>
      ) : (
        <>
          <form onSubmit={onSubmit} className="flex flex-col gap-3">
            <p className="font-medium">
              <Which search={search} />
            </p>
            <div className="grid gap-3 md:grid-cols-2">
              <SelectField<OrderExportFrequency>
                label={t('exports.frequency')}
                value={frequency}
                options={FREQUENCIES.map((each) => ({
                  value: each,
                  label: t(`exports.frequency.${each}` as MessageKey),
                }))}
                onChange={setFrequency}
              />
              <SelectField<string>
                label={t('exports.hour')}
                value={hour}
                options={Array.from({ length: 24 }, (_, at) => ({
                  value: String(at),
                  label: `${String(at).padStart(2, '0')}:00`,
                }))}
                onChange={setHour}
              />
            </div>
            <Shape format={format} layout={layout} onFormat={setFormat} onLayout={setLayout} />
            {problem && <Alert tone="danger">{problem}</Alert>}
            {made && <Alert tone="success">{t('exports.made', { email: me?.email ?? '' })}</Alert>}
            <Button
              type="submit"
              className="self-start"
              busy={create.isPending}
              icon={<CalendarClock aria-hidden className="size-5" />}
            >
              {t('exports.schedule')}
            </Button>
          </form>
          {/* Confirming who they are has a form of its own: beside this one, not in it. */}
          {panel}
        </>
      )}
    </FormSection>
  );
}

/**
 * Orders out of Hatti as files (ORD-11, ADR-182, ADR-183): the orders the list shows, its tab and
 * search, between two days if asked, as Excel or CSV, a row per order or per item, saved now; or
 * the same of each day, week or month, emailed at an hour. Owners, managers and accountants,
 * confirming who they are where they signed in a while ago; every export is on the audit log.
 */
export function OrdersExportPage() {
  const { t } = useLocale();
  const shop = useShop();
  const search = useSearch({ from: '/$shopId/orders/export' });
  if (!EXPORTS_ORDERS.includes(shop.role)) return <EmptyState title={t('exports.cannot')} />;
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 pb-8">
      <Link
        to="/$shopId/orders"
        params={{ shopId: shop.id }}
        search={search}
        className="inline-flex min-h-10 items-center gap-1 self-start text-secondary hover:text-text"
      >
        <ArrowLeft aria-hidden className="size-5 rtl:rotate-180" />
        {t('orders.title')}
      </Link>
      <h1 className="text-[length:var(--hatti-type-display-size)] font-semibold">
        {t('exports.title')}
      </h1>
      <DownloadNow search={search} />
      <Scheduled search={search} />
    </div>
  );
}
