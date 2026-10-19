import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { ArrowLeft, Plus, Ruler, Save, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import {
  CollectionsQuery,
  ProductsSizeChartSetMutation,
  SizeChartCreateMutation,
  SizeChartDeleteMutation,
  SizeChartQuery,
  SizeChartsQuery,
  SizeChartUpdateMutation,
} from '../api/operations';
import type {
  CollectionsData,
  ProductDetail,
  ProductsSizeChartSetData,
  SizeChart,
  SizeChartCreateData,
  SizeChartData,
  SizeChartDeleteData,
  SizeChartInput,
  SizeChartsData,
  SizeChartUnit,
  SizeChartUpdateData,
  UserError,
} from '../api/types';
import { permits } from '../auth/permissions';
import { errorText } from '../i18n/errors';
import { formatCount } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import type { Translate } from '../i18n/locale';
import { SelectField } from '../settings/settings-form';
import { useAdminMutation, useAdminQuery, useShop } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, Card, EmptyState, ErrorState, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';
import { FormSection } from './product-form';
import { EDITS_PRODUCTS } from './status';

/** How big a chart may be, as the core keeps them (ADR-406). */
export const SIZE_CHART_LIMITS = { columns: 8, rows: 30, note: 1000 } as const;

/** A chart as its form holds it: measurements as typed. */
interface Draft {
  name: string;
  unit: SizeChartUnit;
  columns: string[];
  rows: { size: string; values: string[] }[];
  note: string;
}

const EMPTY: Draft = {
  name: '',
  unit: 'INCHES',
  columns: ['', ''],
  rows: [
    { size: '', values: ['', ''] },
    { size: '', values: ['', ''] },
  ],
  note: '',
};

function draftOf(chart: SizeChart): Draft {
  return {
    name: chart.name,
    unit: chart.unit,
    columns: [...chart.columns],
    rows: chart.rows.map((row) => ({
      size: row.size,
      values: row.values.map((value) => (value === null ? '' : String(value))),
    })),
    note: chart.note ?? '',
  };
}

/** A measurement as typed: blank for none, a decimal point or comma either way. */
export function measurementOf(text: string): number | null | undefined {
  const trimmed = text.trim().replace(',', '.');
  if (trimmed === '') return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : undefined;
}

/** What the core is sent; the indexes of measurements that are not numbers, if any. */
function inputOf(draft: Draft): { input: SizeChartInput; bad: [number, number][] } {
  const bad: [number, number][] = [];
  const rows = draft.rows.map((row, rowIndex) => ({
    size: row.size,
    values: row.values.map((text, column) => {
      const value = measurementOf(text);
      if (value === undefined) bad.push([rowIndex, column]);
      return value ?? null;
    }),
  }));
  return {
    input: {
      name: draft.name,
      unit: draft.unit,
      columns: draft.columns,
      rows,
      note: draft.note.trim() === '' ? null : draft.note,
    },
    bad,
  };
}

/** A problem with a chart, said of the part it is about: "Size M, Chest: …". */
function chartProblem(error: UserError, draft: Draft, t: Translate): string {
  const [part, at, inner, column] = (error.field ?? []).filter((each) => each !== 'input');
  const row = at === undefined ? undefined : draft.rows[Number(at)];
  if (part === 'rows' && row && inner === 'values' && column !== undefined) {
    const name = draft.columns[Number(column)] || String(Number(column) + 1);
    return t('sizeCharts.problem.value', {
      size: row.size || String(Number(at) + 1),
      column: name,
      // The core's sentence names no size or column; the admin's words do, in its language.
      message: error.code === 'INVALID' ? t('sizeCharts.outOfRange') : error.message,
    });
  }
  if (part === 'rows' && row) {
    return t('sizeCharts.problem.row', { row: Number(at) + 1, message: error.message });
  }
  if (part === 'columns' && at !== undefined) {
    return t('sizeCharts.problem.column', { column: Number(at) + 1, message: error.message });
  }
  const label = { name: 'sizeCharts.name', unit: 'sizeCharts.unit', note: 'sizeCharts.note' }[
    part ?? ''
  ] as Parameters<Translate>[0] | undefined;
  return label ? `${t(label)}: ${error.message}` : error.message;
}

const unitOptions = (t: Translate) =>
  [
    { value: 'INCHES' as const, label: t('sizeCharts.inches') },
    { value: 'CENTIMETERS' as const, label: t('sizeCharts.centimetres') },
  ] as const;

function backLink(shopId: string, label: string) {
  return (
    <Link
      to="/$shopId/products/size-charts"
      params={{ shopId }}
      className="inline-flex items-center gap-1 self-start text-primary hover:underline"
    >
      <ArrowLeft aria-hidden className="size-4 rtl:rotate-180" />
      {label}
    </Link>
  );
}

/**
 * The shop's size charts (CAT-10, ADR-406), by name: each with its sizes, what it measures and
 * how many products show it; made by those who change products.
 */
export function SizeChartsPage() {
  const { t } = useLocale();
  const shop = useShop();
  const query = useAdminQuery<SizeChartsData>(['sizeCharts'], SizeChartsQuery);
  const edits = permits(shop, EDITS_PRODUCTS);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 pb-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="flex items-center gap-2 text-[length:var(--hatti-type-display-size)] font-semibold">
          <Ruler aria-hidden className="size-7 text-secondary" />
          {t('sizeCharts.title')}
        </h1>
        {edits && (
          <Link
            to="/$shopId/products/size-charts/$chartId"
            params={{ shopId: shop.id, chartId: 'new' }}
            className="inline-flex min-h-12 items-center gap-2 rounded-control bg-primary px-4 font-medium text-on-primary md:min-h-10"
          >
            <Plus aria-hidden className="size-5" />
            {t('sizeCharts.add')}
          </Link>
        )}
      </div>
      <p className="text-secondary">{t('sizeCharts.intro')}</p>
      {query.isPending ? (
        <Loading label={t('state.loading')} />
      ) : query.isError ? (
        <ErrorState
          message={errorText(query.error, t)}
          action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
        />
      ) : query.data.sizeCharts.length === 0 ? (
        <EmptyState title={t('sizeCharts.none')} body={t('sizeCharts.noneHint')} />
      ) : (
        <ul className="flex flex-col gap-3">
          {query.data.sizeCharts.map((chart) => (
            <li key={chart.id}>
              <Card className="flex flex-col gap-1 p-4">
                <Link
                  to="/$shopId/products/size-charts/$chartId"
                  params={{ shopId: shop.id, chartId: chart.id }}
                  className="font-medium text-primary hover:underline"
                  dir="auto"
                >
                  {chart.name}
                </Link>
                <span className="text-secondary" dir="auto">
                  {t('sizeCharts.summary', {
                    sizes: chart.rows.map((row) => row.size).join(', '),
                    columns: chart.columns.join(', '),
                    unit: t(
                      chart.unit === 'INCHES' ? 'sizeCharts.inches' : 'sizeCharts.centimetres',
                    ),
                  })}
                </span>
                <span className="text-secondary">
                  {t('sizeCharts.products', { count: chart.productsCount })}
                </span>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A size chart made or changed: its name, unit, measurements, sizes and note. */
export function SizeChartPage() {
  const { chartId } = useParams({ from: '/$shopId/products/size-charts/$chartId' });
  return chartId === 'new' ? (
    <ChartForm key="new" chart={null} />
  ) : (
    <ChartLoader key={chartId} id={chartId} />
  );
}

function ChartLoader({ id }: { id: string }) {
  const { t } = useLocale();
  const shop = useShop();
  const query = useAdminQuery<SizeChartData>(['sizeChart', id], SizeChartQuery, { id });
  if (query.isPending) return <Loading label={t('state.loading')} />;
  if (query.isError) {
    return (
      <ErrorState
        message={errorText(query.error, t)}
        action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
      />
    );
  }
  if (!query.data.sizeChart) {
    return (
      <div className="mx-auto flex max-w-3xl flex-col gap-4">
        {backLink(shop.id, t('sizeCharts.title'))}
        <EmptyState title={t('sizeCharts.notFound')} />
      </div>
    );
  }
  return <ChartForm chart={query.data.sizeChart} />;
}

function ChartForm({ chart }: { chart: SizeChart | null }) {
  const { t } = useLocale();
  const shop = useShop();
  const navigate = useNavigate();
  const edits = permits(shop, EDITS_PRODUCTS);
  const create = useAdminMutation<SizeChartCreateData, { input: SizeChartInput }>(
    SizeChartCreateMutation,
  );
  const update = useAdminMutation<SizeChartUpdateData, { id: string; input: SizeChartInput }>(
    SizeChartUpdateMutation,
  );
  const remove = useAdminMutation<SizeChartDeleteData, { id: string }>(SizeChartDeleteMutation);
  const [draft, setDraft] = useState<Draft>(chart ? draftOf(chart) : EMPTY);
  const [problems, setProblems] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const change = (next: Partial<Draft>) => {
    setDraft((current) => ({ ...current, ...next }));
    setSaved(false);
  };
  const setColumn = (index: number, name: string) =>
    change({ columns: draft.columns.map((each, at) => (at === index ? name : each)) });
  const addColumn = () =>
    change({
      columns: [...draft.columns, ''],
      rows: draft.rows.map((row) => ({ ...row, values: [...row.values, ''] })),
    });
  const removeColumn = (index: number) =>
    change({
      columns: draft.columns.filter((_, at) => at !== index),
      rows: draft.rows.map((row) => ({
        ...row,
        values: row.values.filter((_, at) => at !== index),
      })),
    });
  const setRow = (index: number, row: Draft['rows'][number]) =>
    change({ rows: draft.rows.map((each, at) => (at === index ? row : each)) });
  const addRow = () =>
    change({ rows: [...draft.rows, { size: '', values: draft.columns.map(() => '') }] });
  const removeRow = (index: number) => change({ rows: draft.rows.filter((_, at) => at !== index) });

  const onSave = async (event: FormEvent) => {
    event.preventDefault();
    setProblems([]);
    const { input, bad } = inputOf(draft);
    if (bad.length > 0) {
      setProblems(
        bad.map(([row, column]) =>
          t('sizeCharts.problem.value', {
            size: draft.rows[row]!.size || String(row + 1),
            column: draft.columns[column] || String(column + 1),
            message: t('sizeCharts.notNumber'),
          }),
        ),
      );
      return;
    }
    try {
      const result = chart
        ? (await update.mutateAsync({ id: chart.id, input })).sizeChartUpdate
        : (await create.mutateAsync({ input })).sizeChartCreate;
      if (result.userErrors.length > 0) {
        setProblems(result.userErrors.map((error) => chartProblem(error, draft, t)));
        return;
      }
      if (!chart && result.sizeChart) {
        void navigate({
          to: '/$shopId/products/size-charts/$chartId',
          params: { shopId: shop.id, chartId: result.sizeChart.id },
          replace: true,
        });
        return;
      }
      setSaved(true);
    } catch (failure) {
      setProblems([errorText(failure, t)]);
    }
  };

  const onDelete = async () => {
    if (!chart) return;
    try {
      const { sizeChartDelete } = await remove.mutateAsync({ id: chart.id });
      if (sizeChartDelete.userErrors.length > 0) {
        setProblems(sizeChartDelete.userErrors.map((error) => chartProblem(error, draft, t)));
        return;
      }
      void navigate({
        to: '/$shopId/products/size-charts',
        params: { shopId: shop.id },
        replace: true,
      });
    } catch (failure) {
      setProblems([errorText(failure, t)]);
    }
  };

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 pb-8">
      {backLink(shop.id, t('sizeCharts.title'))}
      <h1 className="text-[length:var(--hatti-type-display-size)] font-semibold" dir="auto">
        {chart ? chart.name : t('sizeCharts.new')}
      </h1>
      {chart && (
        <p className="text-secondary">{t('sizeCharts.products', { count: chart.productsCount })}</p>
      )}
      <form onSubmit={(event) => void onSave(event)} className="flex flex-col gap-4">
        <fieldset disabled={!edits} className="contents">
          <FormSection title={t('sizeCharts.about')}>
            <TextField
              label={t('sizeCharts.name')}
              hint={t('sizeCharts.nameHint')}
              value={draft.name}
              maxLength={100}
              required
              dir="auto"
              onChange={(event) => change({ name: event.target.value })}
            />
            <SelectField
              label={t('sizeCharts.unit')}
              value={draft.unit}
              options={unitOptions(t)}
              onChange={(unit) => change({ unit })}
            />
          </FormSection>
          <FormSection title={t('sizeCharts.table')} hint={t('sizeCharts.tableHint')}>
            <div className="overflow-x-auto">
              <table className="border-separate border-spacing-1">
                <thead>
                  <tr>
                    <th scope="col" className="text-start font-medium">
                      {t('sizeCharts.size')}
                    </th>
                    {draft.columns.map((column, index) => (
                      <th key={index} scope="col" className="min-w-40 text-start font-normal">
                        <span className="flex items-center gap-1">
                          <input
                            aria-label={t('sizeCharts.columnName', { column: index + 1 })}
                            value={column}
                            maxLength={40}
                            dir="auto"
                            placeholder={t('sizeCharts.columnPlaceholder')}
                            onChange={(event) => setColumn(index, event.target.value)}
                            className="min-h-12 w-full rounded-control border border-line bg-surface px-2 font-medium md:min-h-10"
                          />
                          {draft.columns.length > 1 && (
                            <button
                              type="button"
                              onClick={() => removeColumn(index)}
                              aria-label={t('sizeCharts.removeColumn', {
                                column: column || index + 1,
                              })}
                              className="inline-flex size-10 shrink-0 items-center justify-center rounded-control text-secondary hover:bg-canvas"
                            >
                              <X aria-hidden className="size-4" />
                            </button>
                          )}
                        </span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {draft.rows.map((row, index) => (
                    <tr key={index}>
                      <th scope="row" className="min-w-20 font-normal">
                        <input
                          aria-label={t('sizeCharts.sizeName', { row: index + 1 })}
                          value={row.size}
                          maxLength={20}
                          dir="auto"
                          placeholder={t('sizeCharts.sizePlaceholder')}
                          onChange={(event) => setRow(index, { ...row, size: event.target.value })}
                          className="min-h-12 w-full rounded-control border border-line bg-surface px-2 font-medium md:min-h-10"
                        />
                      </th>
                      {row.values.map((value, column) => (
                        <td key={column}>
                          <input
                            aria-label={t('sizeCharts.measurement', {
                              size: row.size || index + 1,
                              column: draft.columns[column] || column + 1,
                            })}
                            value={value}
                            inputMode="decimal"
                            dir="ltr"
                            onChange={(event) =>
                              setRow(index, {
                                ...row,
                                values: row.values.map((each, at) =>
                                  at === column ? event.target.value : each,
                                ),
                              })
                            }
                            className="min-h-12 w-full rounded-control border border-line bg-surface px-2 md:min-h-10"
                          />
                        </td>
                      ))}
                      <td>
                        {draft.rows.length > 1 && (
                          <button
                            type="button"
                            onClick={() => removeRow(index)}
                            aria-label={t('sizeCharts.removeRow', { size: row.size || index + 1 })}
                            className="inline-flex size-10 items-center justify-center rounded-control text-secondary hover:bg-canvas"
                          >
                            <X aria-hidden className="size-4" />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {edits && (
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  disabled={draft.rows.length >= SIZE_CHART_LIMITS.rows}
                  icon={<Plus aria-hidden className="size-5" />}
                  onClick={addRow}
                >
                  {t('sizeCharts.addRow')}
                </Button>
                <Button
                  variant="secondary"
                  disabled={draft.columns.length >= SIZE_CHART_LIMITS.columns}
                  icon={<Plus aria-hidden className="size-5" />}
                  onClick={addColumn}
                >
                  {t('sizeCharts.addColumn')}
                </Button>
              </div>
            )}
            <div className="flex flex-col gap-1">
              <label htmlFor="size-chart-note" className="font-medium">
                {t('sizeCharts.note')}
              </label>
              <textarea
                id="size-chart-note"
                value={draft.note}
                rows={3}
                dir="auto"
                maxLength={SIZE_CHART_LIMITS.note}
                placeholder={t('sizeCharts.notePlaceholder')}
                onChange={(event) => change({ note: event.target.value })}
                className="rounded-control border border-line bg-surface px-3 py-2 text-text"
              />
            </div>
          </FormSection>
        </fieldset>
        {problems.length > 0 && (
          <Alert tone="danger">
            <ul className="flex flex-col gap-1">
              {problems.map((problem, index) => (
                <li key={index}>{problem}</li>
              ))}
            </ul>
          </Alert>
        )}
        {saved && <Alert tone="success">{t('sizeCharts.saved')}</Alert>}
        {edits && (
          <div className="flex flex-wrap items-center justify-between gap-3">
            {chart &&
              (deleting ? (
                <div className="flex flex-wrap items-center gap-2">
                  <span>{t('sizeCharts.deleteSure')}</span>
                  <Button
                    variant="destructive"
                    busy={remove.isPending}
                    onClick={() => void onDelete()}
                  >
                    {t('sizeCharts.deleteYes')}
                  </Button>
                  <Button variant="tertiary" onClick={() => setDeleting(false)}>
                    {t('action.back')}
                  </Button>
                </div>
              ) : (
                <Button
                  variant="danger"
                  icon={<Trash2 aria-hidden className="size-5" />}
                  onClick={() => setDeleting(true)}
                >
                  {t('sizeCharts.delete')}
                </Button>
              ))}
            <Button
              type="submit"
              busy={create.isPending || update.isPending}
              icon={<Save aria-hidden className="size-5" />}
            >
              {chart ? t('sizeCharts.save') : t('sizeCharts.create')}
            </Button>
          </div>
        )}
      </form>
      {chart && edits && <GiveToCollection chart={chart} />}
    </div>
  );
}

/** Gives a chart to the products a collection has now (ADR-406). */
function GiveToCollection({ chart }: { chart: SizeChart }) {
  const { t } = useLocale();
  const collections = useAdminQuery<CollectionsData>(['collections', ''], CollectionsQuery, {
    query: null,
  });
  const give = useAdminMutation<
    ProductsSizeChartSetData,
    { sizeChartId: string; collectionId: string }
  >(ProductsSizeChartSetMutation);
  const [collectionId, setCollectionId] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [given, setGiven] = useState<number | null>(null);
  const nodes = collections.data?.collections.nodes ?? [];

  const onGive = async (event: FormEvent) => {
    event.preventDefault();
    setProblem(null);
    setGiven(null);
    try {
      const { productsSizeChartSet } = await give.mutateAsync({
        sizeChartId: chart.id,
        collectionId,
      });
      const error = productsSizeChartSet.userErrors[0];
      if (error) setProblem(error.message);
      else setGiven(productsSizeChartSet.productIds.length);
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  return (
    <FormSection title={t('sizeCharts.giveTitle')} hint={t('sizeCharts.giveHint')}>
      <form onSubmit={(event) => void onGive(event)} className="flex flex-col gap-3">
        <SelectField
          label={t('sizeCharts.collection')}
          value={collectionId}
          options={[
            { value: '', label: t('sizeCharts.chooseCollection') },
            ...nodes.map((collection) => ({
              value: collection.id,
              label: `${collection.title} (${formatCount(collection.productsCount)})`,
            })),
          ]}
          onChange={setCollectionId}
        />
        {problem && <Alert tone="danger">{problem}</Alert>}
        {given !== null && <Alert tone="success">{t('sizeCharts.given', { count: given })}</Alert>}
        <Button
          type="submit"
          variant="secondary"
          className="self-start"
          busy={give.isPending}
          disabled={collectionId === ''}
        >
          {t('sizeCharts.give')}
        </Button>
      </form>
    </FormSection>
  );
}

/** The size chart a product's page shows, chosen among the shop's (ADR-406). */
export function ProductSizeChart({ product }: { product: ProductDetail }) {
  const { t } = useLocale();
  const shop = useShop();
  const charts = useAdminQuery<SizeChartsData>(['sizeCharts'], SizeChartsQuery);
  const set = useAdminMutation<
    ProductsSizeChartSetData,
    { sizeChartId: string | null; productIds: string[] }
  >(ProductsSizeChartSetMutation);
  const stored = product.sizeChart?.id ?? '';
  const [chosen, setChosen] = useState(stored);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const list = charts.data?.sizeCharts ?? [];

  const onSave = async (event: FormEvent) => {
    event.preventDefault();
    setProblem(null);
    setSaved(false);
    try {
      const { productsSizeChartSet } = await set.mutateAsync({
        sizeChartId: chosen || null,
        productIds: [product.id],
      });
      const error = productsSizeChartSet.userErrors[0];
      if (error) setProblem(error.message);
      else setSaved(true);
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  return (
    <FormSection title={t('sizeCharts.productTitle')} hint={t('sizeCharts.productHint')}>
      <form onSubmit={(event) => void onSave(event)} className="flex flex-col gap-3">
        {charts.isSuccess && list.length === 0 ? (
          <p className="text-secondary">{t('sizeCharts.noneYet')}</p>
        ) : (
          <SelectField
            label={t('sizeCharts.chart')}
            value={chosen}
            options={[
              { value: '', label: t('sizeCharts.noChart') },
              ...list.map((chart) => ({ value: chart.id, label: chart.name })),
            ]}
            onChange={(next) => {
              setChosen(next);
              setSaved(false);
            }}
          />
        )}
        <Link
          to="/$shopId/products/size-charts"
          params={{ shopId: shop.id }}
          className="self-start text-primary hover:underline"
        >
          {t('sizeCharts.manage')}
        </Link>
        {problem && <Alert tone="danger">{problem}</Alert>}
        {saved && chosen === stored && (
          <Alert tone="success">
            {chosen ? t('sizeCharts.productSaved') : t('sizeCharts.productCleared')}
          </Alert>
        )}
        {list.length > 0 && (
          <Button
            type="submit"
            className="self-start"
            busy={set.isPending}
            disabled={chosen === stored}
            icon={<Ruler aria-hidden className="size-5" />}
          >
            {t('sizeCharts.productSave')}
          </Button>
        )}
      </form>
    </FormSection>
  );
}
