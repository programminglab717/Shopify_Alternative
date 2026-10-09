import { Link } from '@tanstack/react-router';
import { ArrowLeft, Download, FileUp } from 'lucide-react';
import { useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import {
  InventoryExportQuery,
  InventoryImportMutation,
  LocationsQuery,
  ProductsExportQuery,
  ProductsImportMutation,
} from '../api/operations';
import type {
  FileRowError,
  InventoryExportData,
  InventoryImportData,
  InventoryImportResult,
  LocationsData,
  ProductsExportData,
  ProductsImportData,
  ProductsImportResult,
} from '../api/types';
import { errorText } from '../i18n/errors';
import { formatCount } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import { useAttempt } from '../returns/parcel';
import { CheckField, SelectField } from '../settings/settings-form';
import { useAdminMutation, useAdminQuery, useShop } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, EmptyState } from '../ui/feedback';
import { FormSection } from './product-form';
import { EDITS_PRODUCTS } from './status';

/** A file the browser saves, as an export does. */
function save(csv: string, name: string) {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  link.download = name;
  link.click();
  URL.revokeObjectURL(link.href);
}

/** The first rows of a file the core could not take, and how many there were in all. */
function RowErrors({ count, errors }: { count: number; errors: FileRowError[] }) {
  const { t } = useLocale();
  if (count === 0) return null;
  return (
    <Alert tone="warning">
      <span className="flex flex-col gap-1">
        <span>{t('moving.rowErrors', { count })}</span>
        {errors.slice(0, 5).map((error) => (
          <span key={`${error.row}-${error.column ?? ''}`}>
            {t('moving.rowError', {
              row: error.row,
              column: error.column ?? '',
              message: error.message,
            })}
          </span>
        ))}
      </span>
    </Alert>
  );
}

/** A CSV chosen from the phone or computer, read as text. */
function useChosenFile(onChosen: (file: { name: string; csv: string }) => void) {
  const input = useRef<HTMLInputElement>(null);
  const onChange = (event: ChangeEvent<HTMLInputElement>) => {
    const chosen = event.target.files?.[0];
    event.target.value = '';
    if (chosen) void chosen.text().then((csv) => onChosen({ name: chosen.name, csv }));
  };
  return { input, onChange, choose: () => input.current?.click() };
}

/**
 * Products from Shopify's product CSV (ONB-05, CAT-05): checked first, saying what it would make,
 * update and leave and what it could not read; then taken in at a tap. Products the shop has
 * already are left as they are unless staff ask to update them from the file.
 */
function ImportProducts() {
  const { t } = useLocale();
  const run = useAdminMutation<
    ProductsImportData,
    { csv: string; dryRun: boolean; overwrite: boolean }
  >(ProductsImportMutation);
  const { problem, attempt } = useAttempt();
  const [overwrite, setOverwrite] = useState(false);
  const [file, setFile] = useState<{ name: string; csv: string } | null>(null);
  const [checked, setChecked] = useState<ProductsImportResult | null>(null);
  const [done, setDone] = useState<ProductsImportResult | null>(null);

  const send = async (csv: string, dryRun: boolean, update: boolean) => {
    const answer: { value?: ProductsImportResult } = {};
    const ok = await attempt(async () => {
      answer.value = (await run.mutateAsync({ csv, dryRun, overwrite: update })).productsImport;
      return answer.value;
    });
    return ok ? answer.value! : null;
  };

  const check = async (chosen: { name: string; csv: string }, update: boolean) => {
    setDone(null);
    setChecked(null);
    setFile(chosen);
    setChecked(await send(chosen.csv, true, update));
  };
  const picker = useChosenFile((chosen) => void check(chosen, overwrite));

  return (
    <FormSection title={t('files.importProducts')} hint={t('files.importProductsHint')}>
      <CheckField
        label={t('files.overwrite')}
        hint={t('files.overwriteHint')}
        checked={overwrite}
        onChange={(next) => {
          setOverwrite(next);
          if (file && !done) void check(file, next);
        }}
      />
      <Button
        variant="secondary"
        className="self-start"
        icon={<FileUp aria-hidden className="size-5" />}
        busy={run.isPending && !checked}
        onClick={picker.choose}
      >
        {t('files.choose')}
      </Button>
      <input
        ref={picker.input}
        type="file"
        accept=".csv,text/csv"
        className="hidden"
        aria-label={t('files.productsFile')}
        onChange={picker.onChange}
      />
      {file && checked && !done && (
        <div className="flex flex-col gap-2 rounded-control border border-line p-3">
          <p>
            {t('files.productsChecked', {
              name: file.name,
              rows: formatCount(checked.rows),
              created: formatCount(checked.created),
              updated: formatCount(checked.updated),
              skipped: formatCount(checked.skipped),
              variants: formatCount(checked.variants),
            })}
          </p>
          <RowErrors count={checked.rowErrorCount} errors={checked.rowErrors} />
          {checked.created + checked.updated > 0 && (
            <Button
              className="self-start"
              busy={run.isPending}
              onClick={() =>
                void send(file.csv, false, overwrite).then((result) => {
                  if (result) {
                    setDone(result);
                    setChecked(null);
                  }
                })
              }
            >
              {t('files.importProductsConfirm')}
            </Button>
          )}
        </div>
      )}
      {done && (
        <Alert tone="success">
          {t('files.productsImported', {
            created: formatCount(done.created),
            updated: formatCount(done.updated),
            skipped: formatCount(done.skipped),
            images: formatCount(done.images),
            stocked: formatCount(done.stocked),
          })}
        </Alert>
      )}
      {problem && <Alert tone="danger">{problem}</Alert>}
    </FormSection>
  );
}

/** The shop's products as Shopify's product CSV: all of them, or those a search finds. */
function ExportProducts() {
  const { t } = useLocale();
  const [words, setWords] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<{ products: number; rows: number } | null>(null);
  const exporting = useAdminQuery<ProductsExportData>(
    ['productsExport', words.trim()],
    ProductsExportQuery,
    { query: words.trim() || null },
    { enabled: false },
  );

  const download = async () => {
    setProblem(null);
    setDone(null);
    const { data, error } = await exporting.refetch();
    if (!data) {
      setProblem(errorText(error, t));
      return;
    }
    save(data.productsExport.csv, 'products_export.csv');
    setDone({ products: data.productsExport.productCount, rows: data.productsExport.rowCount });
  };

  return (
    <FormSection title={t('files.exportProducts')} hint={t('files.exportProductsHint')}>
      <div className="flex flex-col gap-1">
        <label htmlFor="export-products" className="font-medium">
          {t('files.which')}
        </label>
        <input
          id="export-products"
          type="search"
          dir="auto"
          placeholder={t('files.whichPlaceholder')}
          value={words}
          onChange={(event) => setWords(event.target.value)}
          className="min-h-12 rounded-control border border-line bg-surface px-3 md:min-h-10"
        />
      </div>
      {problem && <Alert tone="danger">{problem}</Alert>}
      {done && (
        <Alert tone="success">
          {t('files.productsExported', {
            products: formatCount(done.products),
            rows: formatCount(done.rows),
          })}
        </Alert>
      )}
      <Button
        variant="secondary"
        className="self-start"
        icon={<Download aria-hidden className="size-5" />}
        busy={exporting.isFetching}
        onClick={() => void download()}
      >
        {t('files.downloadProducts')}
      </Button>
    </FormSection>
  );
}

/**
 * A stock count by file (CAT-05): the shop's stock as Shopify's inventory CSV, at one location or
 * all, to fill On hand (new) in a spreadsheet; then the file checked, saying what it would count,
 * leave and could not read, and counted at a tap. Stock that sold since the file was saved is
 * not counted over.
 */
function StockCount() {
  const { t } = useLocale();
  const locations = useAdminQuery<LocationsData>(['locations'], LocationsQuery);
  const [locationId, setLocationId] = useState('');
  const [exportProblem, setExportProblem] = useState<string | null>(null);
  const [exported, setExported] = useState<number | null>(null);
  const exporting = useAdminQuery<InventoryExportData>(
    ['inventoryExport', locationId],
    InventoryExportQuery,
    { locationId: locationId || null },
    { enabled: false },
  );
  const run = useAdminMutation<InventoryImportData, { csv: string; dryRun: boolean }>(
    InventoryImportMutation,
  );
  const { problem, attempt } = useAttempt();
  const [file, setFile] = useState<{ name: string; csv: string } | null>(null);
  const [checked, setChecked] = useState<InventoryImportResult | null>(null);
  const [done, setDone] = useState<InventoryImportResult | null>(null);

  const send = async (csv: string, dryRun: boolean) => {
    const answer: { value?: InventoryImportResult } = {};
    const ok = await attempt(async () => {
      answer.value = (await run.mutateAsync({ csv, dryRun })).inventoryImport;
      return answer.value;
    });
    return ok ? answer.value! : null;
  };
  const picker = useChosenFile((chosen) => {
    setDone(null);
    setChecked(null);
    setFile(chosen);
    void send(chosen.csv, true).then(setChecked);
  });

  const download = async () => {
    setExportProblem(null);
    setExported(null);
    const { data, error } = await exporting.refetch();
    if (!data) {
      setExportProblem(errorText(error, t));
      return;
    }
    save(data.inventoryExport.csv, 'inventory_export.csv');
    setExported(data.inventoryExport.rowCount);
  };

  return (
    <FormSection title={t('files.stock')} hint={t('files.stockHint')}>
      <SelectField
        label={t('files.location')}
        value={locationId}
        options={[
          { value: '', label: t('files.everyLocation') },
          ...(locations.data?.locations.nodes ?? []).map((location) => ({
            value: location.id,
            label: location.name,
          })),
        ]}
        onChange={setLocationId}
      />
      {exportProblem && <Alert tone="danger">{exportProblem}</Alert>}
      {exported !== null && (
        <Alert tone="success">{t('files.stockExported', { rows: formatCount(exported) })}</Alert>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          icon={<Download aria-hidden className="size-5" />}
          busy={exporting.isFetching}
          onClick={() => void download()}
        >
          {t('files.downloadStock')}
        </Button>
        <Button
          variant="secondary"
          icon={<FileUp aria-hidden className="size-5" />}
          busy={run.isPending && !checked}
          onClick={picker.choose}
        >
          {t('files.chooseCount')}
        </Button>
      </div>
      <input
        ref={picker.input}
        type="file"
        accept=".csv,text/csv"
        className="hidden"
        aria-label={t('files.stockFile')}
        onChange={picker.onChange}
      />
      {file && checked && !done && (
        <div className="flex flex-col gap-2 rounded-control border border-line p-3">
          <p>
            {t('files.stockChecked', {
              name: file.name,
              rows: formatCount(checked.rows),
              counted: formatCount(checked.counted),
              unchanged: formatCount(checked.unchanged),
            })}
          </p>
          <RowErrors count={checked.rowErrorCount} errors={checked.rowErrors} />
          {checked.counted > 0 && (
            <Button
              className="self-start"
              busy={run.isPending}
              onClick={() =>
                void send(file.csv, false).then((result) => {
                  if (result) {
                    setDone(result);
                    setChecked(null);
                  }
                })
              }
            >
              {t('files.countConfirm')}
            </Button>
          )}
        </div>
      )}
      {done && (
        <Alert tone="success">
          {t('files.counted', {
            counted: formatCount(done.counted),
            unchanged: formatCount(done.unchanged),
          })}
        </Alert>
      )}
      {problem && <Alert tone="danger">{problem}</Alert>}
    </FormSection>
  );
}

/** Products and stock in and out of Hatti by file (CAT-05, ONB-05), for owners and managers. */
export function ProductFilesPage() {
  const { t } = useLocale();
  const { id: shopId, role } = useShop();
  if (!EDITS_PRODUCTS.includes(role)) return <EmptyState title={t('files.cannot')} />;
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 pb-8">
      <Link
        to="/$shopId/products"
        params={{ shopId }}
        className="inline-flex min-h-10 items-center gap-1 self-start text-secondary hover:text-text"
      >
        <ArrowLeft aria-hidden className="size-5 rtl:rotate-180" />
        {t('products.title')}
      </Link>
      <h1 className="text-[length:var(--hatti-type-display-size)] font-semibold">
        {t('files.title')}
      </h1>
      <ImportProducts />
      <ExportProducts />
      <StockCount />
    </div>
  );
}
