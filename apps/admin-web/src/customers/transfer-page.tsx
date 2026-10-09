import { Link } from '@tanstack/react-router';
import { ArrowLeft, Download, FileUp } from 'lucide-react';
import { useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { CustomersExportMutation, CustomersImportMutation, SegmentsQuery } from '../api/operations';
import type {
  CustomersExportData,
  CustomersImportData,
  CustomersImportResult,
  SegmentsData,
} from '../api/types';
import { useRecentAuthentication } from '../auth/confirm-identity';
import type { StaffRole } from '../auth/session';
import { errorText } from '../i18n/errors';
import { formatCount } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import { FormSection, problemText } from '../products/product-form';
import { useAttempt } from '../returns/parcel';
import { CheckField } from '../settings/settings-form';
import { useAdminMutation, useAdminQuery, useShop } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, EmptyState } from '../ui/feedback';

/** Those who take customers in and out of Hatti: owners and managers (CUS-07). */
export const MOVES_CUSTOMERS: readonly StaffRole[] = ['owner', 'manager'];

/** A file the browser saves, as an export does. */
function save(csv: string, name: string) {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  link.download = name;
  link.click();
  URL.revokeObjectURL(link.href);
}

/**
 * Customers as CSV, everyone or a segment's, once the member has confirmed who they are where
 * they signed in a while ago; the core records every export.
 */
function ExportCustomers() {
  const { t } = useLocale();
  const segments = useAdminQuery<SegmentsData>(['segments'], SegmentsQuery);
  const exporting = useAdminMutation<CustomersExportData, { segmentId: string | null }>(
    CustomersExportMutation,
  );
  const { run, panel } = useRecentAuthentication();
  const [segmentId, setSegmentId] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<number | null>(null);

  const download = () => {
    setProblem(null);
    setDone(null);
    void run(
      async () => {
        const { customersExport } = await exporting.mutateAsync({ segmentId: segmentId || null });
        const error = customersExport.userErrors[0];
        if (error || customersExport.csv === null) {
          setProblem(error ? problemText(error, t) : t('state.error'));
          return;
        }
        save(customersExport.csv, 'customers.csv');
        setDone(customersExport.rowCount);
      },
      (failure) => setProblem(errorText(failure, t)),
    );
  };

  return (
    <FormSection title={t('moving.export')} hint={t('moving.exportHint')}>
      <div className="flex flex-col gap-1">
        <label htmlFor="export-who" className="font-medium">
          {t('moving.who')}
        </label>
        <select
          id="export-who"
          value={segmentId}
          onChange={(event) => setSegmentId(event.target.value)}
          className="min-h-12 rounded-control border border-line bg-surface px-2 md:min-h-10"
        >
          <option value="">{t('moving.everyone')}</option>
          {segments.data?.segments.nodes.map((segment) => (
            <option key={segment.id} value={segment.id}>
              {t('moving.segment', {
                name: segment.name,
                count: formatCount(segment.memberCount),
              })}
            </option>
          ))}
        </select>
      </div>
      {panel}
      {problem && <Alert tone="danger">{problem}</Alert>}
      {done !== null && (
        <Alert tone="success">{t('moving.exported', { count: formatCount(done) })}</Alert>
      )}
      <Button
        variant="secondary"
        className="self-start"
        icon={<Download aria-hidden className="size-5" />}
        busy={exporting.isPending}
        onClick={download}
      >
        {t('moving.download')}
      </Button>
    </FormSection>
  );
}

/**
 * Customers from a CSV, Hatti's own, Shopify's or a spreadsheet with a Phone column: checked
 * first, saying what it would add, update, skip and could not read; then taken in at a tap.
 */
function ImportCustomers() {
  const { t } = useLocale();
  const run = useAdminMutation<
    CustomersImportData,
    { csv: string; dryRun: boolean; overwrite: boolean }
  >(CustomersImportMutation);
  const { problem, attempt } = useAttempt();
  const input = useRef<HTMLInputElement>(null);
  const [overwrite, setOverwrite] = useState(false);
  const [file, setFile] = useState<{ name: string; csv: string } | null>(null);
  const [checked, setChecked] = useState<CustomersImportResult | null>(null);
  const [done, setDone] = useState<CustomersImportResult | null>(null);

  const send = async (csv: string, dryRun: boolean, update: boolean) => {
    const answer: { value?: CustomersImportResult } = {};
    const ok = await attempt(async () => {
      answer.value = (await run.mutateAsync({ csv, dryRun, overwrite: update })).customersImport;
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

  const onChosen = (event: ChangeEvent<HTMLInputElement>) => {
    const chosen = event.target.files?.[0];
    event.target.value = '';
    if (chosen) void chosen.text().then((csv) => check({ name: chosen.name, csv }, overwrite));
  };

  return (
    <FormSection title={t('moving.import')} hint={t('moving.importHint')}>
      <CheckField
        label={t('moving.overwrite')}
        hint={t('moving.overwriteHint')}
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
        onClick={() => input.current?.click()}
      >
        {t('moving.choose')}
      </Button>
      <input
        ref={input}
        type="file"
        accept=".csv,text/csv"
        className="hidden"
        aria-label={t('moving.file')}
        onChange={onChosen}
      />
      {file && checked && !done && (
        <div className="flex flex-col gap-2 rounded-control border border-line p-3">
          <p>
            {t('moving.checked', {
              name: file.name,
              rows: formatCount(checked.rows),
              created: formatCount(checked.created),
              updated: formatCount(checked.updated),
              skipped: formatCount(checked.skipped),
            })}
          </p>
          {checked.rowErrorCount > 0 && (
            <Alert tone="warning">
              <span className="flex flex-col gap-1">
                <span>{t('moving.rowErrors', { count: checked.rowErrorCount })}</span>
                {checked.rowErrors.slice(0, 5).map((error) => (
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
          )}
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
              {t('moving.importConfirm')}
            </Button>
          )}
        </div>
      )}
      {done && (
        <Alert tone="success">
          {t('moving.imported', {
            created: formatCount(done.created),
            updated: formatCount(done.updated),
            skipped: formatCount(done.skipped),
          })}
        </Alert>
      )}
      {problem && <Alert tone="danger">{problem}</Alert>}
    </FormSection>
  );
}

/** Customers in and out of Hatti (CUS-07): exported as CSV, and imported from one. */
export function CustomersTransferPage() {
  const { t } = useLocale();
  const { id: shopId, role } = useShop();
  if (!MOVES_CUSTOMERS.includes(role)) return <EmptyState title={t('moving.cannot')} />;
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 pb-8">
      <Link
        to="/$shopId/customers"
        params={{ shopId }}
        className="inline-flex min-h-10 items-center gap-1 self-start text-secondary hover:text-text"
      >
        <ArrowLeft aria-hidden className="size-5 rtl:rotate-180" />
        {t('customers.title')}
      </Link>
      <h1 className="text-[length:var(--hatti-type-display-size)] font-semibold">
        {t('moving.title')}
      </h1>
      <ImportCustomers />
      <ExportCustomers />
    </div>
  );
}
