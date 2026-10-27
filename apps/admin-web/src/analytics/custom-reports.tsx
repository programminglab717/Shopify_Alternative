import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { ArrowLeft, CalendarClock, Download, FilePlus2, Save, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import {
  CustomReportColumnsQuery,
  CustomReportCreateMutation,
  CustomReportDeleteMutation,
  CustomReportExportMutation,
  CustomReportQuery,
  CustomReportUpdateMutation,
  CustomReportsQuery,
  OrderExportScheduleCreateMutation,
} from '../api/operations';
import type {
  CustomReportBreakdown,
  CustomReportColumnValue,
  CustomReportColumnsData,
  CustomReportCreateData,
  CustomReportData,
  CustomReportDeleteData,
  CustomReportExportData,
  CustomReportPeriod,
  CustomReportResultValue,
  CustomReportUpdateData,
  CustomReportValue,
  CustomReportsData,
  OrderExportFrequency,
  OrderExportScheduleCreateData,
} from '../api/types';
import { useMe } from '../auth/context';
import { useRecentAuthentication } from '../auth/confirm-identity';
import { permits } from '../auth/permissions';
import { errorText } from '../i18n/errors';
import { formatCount, formatMoney, formatTimes } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { EXPORTS_ORDERS, save } from '../orders/export-page';
import { FormSection, problemText } from '../products/product-form';
import { CheckField, SelectField } from '../settings/settings-form';
import { useAdminMutation, useAdminQuery, useShop } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, EmptyState, ErrorState, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';

export const BREAKDOWNS: readonly CustomReportBreakdown[] = [
  'DAY',
  'WEEK',
  'MONTH',
  'PRODUCT',
  'SOURCE',
  'VISIT_SOURCE',
  'CAMPAIGN',
];

export const PERIODS: readonly CustomReportPeriod[] = [
  'TODAY',
  'YESTERDAY',
  'LAST_7_DAYS',
  'LAST_30_DAYS',
  'LAST_90_DAYS',
  'THIS_WEEK',
  'LAST_WEEK',
  'THIS_MONTH',
  'LAST_MONTH',
  'LAST_12_MONTHS',
  'THIS_YEAR',
];

const FREQUENCIES: readonly OrderExportFrequency[] = ['DAILY', 'WEEKLY', 'MONTHLY'];

/** What a new report shows until the shop chooses. */
const USUAL: Readonly<Record<'sales' | 'products', string[]>> = {
  sales: ['orders', 'net_sales', 'total_sales'],
  products: ['units_sold', 'gross_sales'],
};

type Draft = Omit<CustomReportValue, 'id'>;

const NEW: Draft = {
  name: '',
  breakdown: 'MONTH',
  columns: USUAL.sales,
  period: 'LAST_12_MONTHS',
};

/** A cell as the merchant reads it: Rs for amounts, a percentage for a margin, × for a return. */
export function cellText(value: string | null, column: CustomReportColumnValue): string {
  if (value === null) return '–';
  if (column.kind === 'AMOUNT') return formatMoney(value);
  if (column.kind === 'NUMBER') return formatCount(Number(value));
  if (column.key === 'return_on_ad_spend') return formatTimes(Number(value));
  return `${(Number(value) * 100).toFixed(1)}%`;
}

/** What a report is, chosen: its name, rows, period and columns, in the order chosen. */
function ReportEditor({
  initial,
  saving,
  submit,
  onSave,
}: {
  initial: Draft;
  saving: boolean;
  submit: string;
  onSave: (draft: Draft) => Promise<string | null>;
}) {
  const { t } = useLocale();
  const [draft, setDraft] = useState(initial);
  const [problem, setProblem] = useState<string | null>(null);
  const columns = useAdminQuery<CustomReportColumnsData>(
    ['customReportColumns', draft.breakdown],
    CustomReportColumnsQuery,
    { breakdown: draft.breakdown },
  );
  const offered = columns.data?.customReportColumns ?? [];

  const onBreakdown = (breakdown: CustomReportBreakdown) => {
    const products = (each: CustomReportBreakdown) => each === 'PRODUCT';
    // The columns of products are not those of sales: the usual ones of the other kind.
    const columns =
      products(breakdown) === products(draft.breakdown)
        ? draft.columns
        : USUAL[products(breakdown) ? 'products' : 'sales'];
    setDraft({ ...draft, breakdown, columns });
  };

  const toggle = (key: string, on: boolean) =>
    setDraft({
      ...draft,
      columns: on ? [...draft.columns, key] : draft.columns.filter((each) => each !== key),
    });

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setProblem(null);
    setProblem(await onSave(draft));
  };

  return (
    <form onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-3">
      <TextField
        label={t('reports.name')}
        required
        maxLength={80}
        dir="auto"
        value={draft.name}
        onChange={(event) => setDraft({ ...draft, name: event.target.value })}
      />
      <div className="grid gap-3 md:grid-cols-2">
        <SelectField<CustomReportBreakdown>
          label={t('reports.breakdown')}
          value={draft.breakdown}
          options={BREAKDOWNS.map((each) => ({
            value: each,
            label: t(`reports.breakdown.${each}` as MessageKey),
          }))}
          onChange={onBreakdown}
        />
        <SelectField<CustomReportPeriod>
          label={t('reports.period')}
          value={draft.period}
          options={PERIODS.map((each) => ({
            value: each,
            label: t(`reports.period.${each}` as MessageKey),
          }))}
          onChange={(period) => setDraft({ ...draft, period })}
        />
      </div>
      <fieldset className="flex flex-col gap-1">
        <legend className="font-medium">{t('reports.columns')}</legend>
        <p className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
          {t('reports.columnsHint')}
        </p>
        <div className="grid gap-x-4 sm:grid-cols-2">
          {offered.map((column) => (
            <CheckField
              key={column.key}
              label={
                column.trueProfit ? t('reports.trueProfit', { name: column.title }) : column.title
              }
              checked={draft.columns.includes(column.key)}
              onChange={(on) => toggle(column.key, on)}
            />
          ))}
        </div>
      </fieldset>
      {problem && <Alert tone="danger">{problem}</Alert>}
      <Button
        type="submit"
        className="self-start"
        busy={saving}
        disabled={draft.columns.length === 0 || !draft.name.trim()}
        icon={<Save aria-hidden className="size-5" />}
      >
        {submit}
      </Button>
    </form>
  );
}

/**
 * Custom reports (ANL-06, ADR-819): the shop's own, by name, each opened to see it; and a new one
 * made, opened once saved.
 */
export function ReportsPage() {
  const { t } = useLocale();
  const shop = useShop();
  const navigate = useNavigate();
  const reports = useAdminQuery<CustomReportsData>(['customReports'], CustomReportsQuery);
  const create = useAdminMutation<CustomReportCreateData, { input: Draft }>(
    CustomReportCreateMutation,
  );
  const [making, setMaking] = useState(false);

  const onCreate = async (draft: Draft): Promise<string | null> => {
    try {
      const { customReportCreate } = await create.mutateAsync({ input: draft });
      const error = customReportCreate.userErrors[0];
      if (error || !customReportCreate.customReport) {
        return error ? problemText(error, t) : t('state.error');
      }
      void navigate({
        to: '/$shopId/analytics/reports/$reportId',
        params: { shopId: shop.id, reportId: customReportCreate.customReport.id },
      });
      return null;
    } catch (failure) {
      return errorText(failure, t);
    }
  };

  const list = reports.data?.customReports ?? [];
  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4 pb-8">
      <Link
        to="/$shopId/analytics"
        params={{ shopId: shop.id }}
        className="inline-flex items-center gap-2 self-start text-secondary hover:underline"
      >
        <ArrowLeft aria-hidden className="size-5 rtl:rotate-180" />
        {t('analytics.title')}
      </Link>
      <h1 className="text-[length:var(--hatti-type-display-size)] font-semibold">
        {t('reports.title')}
      </h1>
      <p className="text-secondary">{t('reports.hint')}</p>
      {reports.isPending ? (
        <Loading label={t('state.loading')} />
      ) : reports.isError ? (
        <ErrorState message={errorText(reports.error, t)} />
      ) : list.length === 0 ? (
        <EmptyState title={t('reports.none')} />
      ) : (
        <ul aria-label={t('reports.title')} className="flex flex-col divide-y divide-line">
          {list.map((report) => (
            <li key={report.id} className="flex flex-wrap items-baseline gap-3 py-2">
              <Link
                to="/$shopId/analytics/reports/$reportId"
                params={{ shopId: shop.id, reportId: report.id }}
                className="min-w-0 flex-1 font-medium underline-offset-4 hover:underline"
                dir="auto"
              >
                {report.name}
              </Link>
              <span className="text-secondary">
                {t(`reports.breakdown.${report.breakdown}` as MessageKey)} ·{' '}
                {t(`reports.period.${report.period}` as MessageKey)}
              </span>
            </li>
          ))}
        </ul>
      )}
      {making ? (
        <FormSection title={t('reports.new')}>
          <ReportEditor
            initial={NEW}
            saving={create.isPending}
            submit={t('reports.create')}
            onSave={onCreate}
          />
        </FormSection>
      ) : (
        <Button
          className="self-start"
          icon={<FilePlus2 aria-hidden className="size-5" />}
          onClick={() => setMaking(true)}
        >
          {t('reports.new')}
        </Button>
      )}
    </div>
  );
}

/** What a report shows: a row each, the period's total last for one of sales. */
function ReportTable({ result }: { result: CustomReportResultValue }) {
  const { t } = useLocale();
  if (result.rows.length === 0) return <p className="text-secondary">{t('analytics.noSales')}</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-max text-start">
        <thead>
          <tr className="border-b border-line">
            <th scope="col" className="py-2 pe-4 text-start font-medium">
              <span className="sr-only">{t('reports.row')}</span>
            </th>
            {result.columns.map((column) => (
              <th key={column.key} scope="col" className="py-2 pe-4 text-end font-medium">
                {column.title}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {result.rows.map((row, index) => (
            <tr key={row.key ?? `${row.label}-${index}`}>
              <th scope="row" className="py-2 pe-4 text-start font-normal" dir="auto">
                {row.label}
              </th>
              {row.values.map((value, at) => (
                <td key={result.columns[at]!.key} className="num py-2 pe-4 text-end">
                  {cellText(value, result.columns[at]!)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {result.totals && (
          <tfoot>
            <tr className="border-t border-line font-medium">
              <th scope="row" className="py-2 pe-4 text-start">
                {t('reports.total')}
              </th>
              {result.totals.map((value, at) => (
                <td key={result.columns[at]!.key} className="num py-2 pe-4 text-end">
                  {cellText(value, result.columns[at]!)}
                </td>
              ))}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

/** A report emailed each day, week or month to the member asking (ADR-818). */
function ScheduleReport({ reportId }: { reportId: string }) {
  const { t } = useLocale();
  const me = useMe().data?.user;
  const create = useAdminMutation<OrderExportScheduleCreateData, Record<string, unknown>>(
    OrderExportScheduleCreateMutation,
  );
  const { run, panel } = useRecentAuthentication();
  const [frequency, setFrequency] = useState<OrderExportFrequency>('WEEKLY');
  const [hour, setHour] = useState('8');
  const [problem, setProblem] = useState<string | null>(null);
  const [made, setMade] = useState(false);

  if (me && (!me.email || me.emailVerified === false)) {
    return <Alert tone="warning">{t('exports.noEmail')}</Alert>;
  }

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    setProblem(null);
    setMade(false);
    void run(
      async () => {
        const { orderExportScheduleCreate } = await create.mutateAsync({
          input: { frequency, hour: Number(hour), customReportId: reportId },
        });
        const error = orderExportScheduleCreate.userErrors[0];
        if (error) setProblem(problemText(error, t));
        else setMade(true);
      },
      (failure) => setProblem(errorText(failure, t)),
    );
  };

  return (
    <FormSection title={t('reports.schedule')} hint={t('reports.scheduleHint')}>
      <form onSubmit={onSubmit} className="flex flex-col gap-3">
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
        {problem && <Alert tone="danger">{problem}</Alert>}
        {made && <Alert tone="success">{t('exports.made', { email: me?.email ?? '' })}</Alert>}
        <Button
          type="submit"
          className="self-start"
          busy={create.isPending}
          icon={<CalendarClock aria-hidden className="size-5" />}
        >
          {t('reports.scheduleSave')}
        </Button>
      </form>
      {/* Confirming who they are has a form of its own: beside this one, not in it. */}
      {panel}
    </FormSection>
  );
}

/**
 * One custom report (ADR-819): what it shows over its period now; downloaded as a workbook and
 * scheduled by those who export orders; changed, and deleted with its schedules.
 */
export function ReportPage() {
  const { t } = useLocale();
  const shop = useShop();
  const navigate = useNavigate();
  const { reportId } = useParams({ from: '/$shopId/analytics/reports/$reportId' });
  const query = useAdminQuery<CustomReportData>(['customReport', reportId], CustomReportQuery, {
    id: reportId,
  });
  const update = useAdminMutation<CustomReportUpdateData, { id: string; input: Draft }>(
    CustomReportUpdateMutation,
  );
  const remove = useAdminMutation<CustomReportDeleteData, { id: string }>(
    CustomReportDeleteMutation,
  );
  const exporting = useAdminMutation<CustomReportExportData, { id: string }>(
    CustomReportExportMutation,
  );
  const [editing, setEditing] = useState(false);
  const [asking, setAsking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const exports = permits(shop, EXPORTS_ORDERS);

  const back = (
    <Link
      to="/$shopId/analytics/reports"
      params={{ shopId: shop.id }}
      className="inline-flex items-center gap-2 self-start text-secondary hover:underline"
    >
      <ArrowLeft aria-hidden className="size-5 rtl:rotate-180" />
      {t('reports.title')}
    </Link>
  );
  if (query.isPending) return <Loading label={t('state.loading')} />;
  if (query.isError) return <ErrorState message={errorText(query.error, t)} />;
  const report = query.data.customReport;
  const result = query.data.customReportRun;
  if (!report || !result) {
    return (
      <div className="mx-auto flex max-w-4xl flex-col gap-4 pb-8">
        {back}
        <EmptyState title={t('reports.notFound')} />
      </div>
    );
  }

  const onUpdate = async (draft: Draft): Promise<string | null> => {
    try {
      const { customReportUpdate } = await update.mutateAsync({ id: report.id, input: draft });
      const error = customReportUpdate.userErrors[0];
      if (error) return problemText(error, t);
      setEditing(false);
      return null;
    } catch (failure) {
      return errorText(failure, t);
    }
  };

  const onDownload = async () => {
    setProblem(null);
    try {
      const { customReportExport } = await exporting.mutateAsync({ id: report.id });
      const error = customReportExport.userErrors[0];
      if (error || !customReportExport.file) {
        setProblem(error ? problemText(error, t) : t('state.error'));
        return;
      }
      save(customReportExport.file);
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  const onDelete = async () => {
    setProblem(null);
    try {
      await remove.mutateAsync({ id: report.id });
      void navigate({ to: '/$shopId/analytics/reports', params: { shopId: shop.id } });
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4 pb-8">
      {back}
      <h1 className="text-[length:var(--hatti-type-display-size)] font-semibold" dir="auto">
        {report.name}
      </h1>
      <p className="text-secondary">
        {t(`reports.breakdown.${report.breakdown}` as MessageKey)} ·{' '}
        {t(`reports.period.${report.period}` as MessageKey)}
      </p>
      <div className="flex flex-wrap gap-2">
        {exports && (
          <Button
            variant="secondary"
            busy={exporting.isPending}
            icon={<Download aria-hidden className="size-5" />}
            onClick={() => void onDownload()}
          >
            {t('reports.download')}
          </Button>
        )}
        <Button variant="secondary" onClick={() => setEditing(!editing)}>
          {t('reports.edit')}
        </Button>
        <Button
          variant="danger"
          icon={<Trash2 aria-hidden className="size-5" />}
          onClick={() => setAsking(true)}
        >
          {t('reports.delete')}
        </Button>
      </div>
      {asking && (
        <div className="flex flex-col gap-3 rounded-card border border-line bg-surface p-4">
          <p>{t('reports.deleteAsk', { name: report.name })}</p>
          <div className="flex flex-wrap gap-2">
            <Button variant="destructive" busy={remove.isPending} onClick={() => void onDelete()}>
              {t('reports.deleteYes')}
            </Button>
            <Button variant="secondary" onClick={() => setAsking(false)}>
              {t('reports.keep')}
            </Button>
          </div>
        </div>
      )}
      {problem && <Alert tone="danger">{problem}</Alert>}
      {editing && (
        <FormSection title={t('reports.edit')}>
          <ReportEditor
            initial={{
              name: report.name,
              breakdown: report.breakdown,
              columns: report.columns,
              period: report.period,
            }}
            saving={update.isPending}
            submit={t('reports.save')}
            onSave={onUpdate}
          />
        </FormSection>
      )}
      <FormSection title={t('reports.shows')}>
        <ReportTable result={result} />
      </FormSection>
      {exports && <ScheduleReport reportId={report.id} />}
    </div>
  );
}
