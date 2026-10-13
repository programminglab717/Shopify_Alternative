import { Archive, Download } from 'lucide-react';
import { useState } from 'react';
import { StoreExportCreateMutation, StoreExportsQuery } from '../api/operations';
import type { StoreExport, StoreExportCreateData, StoreExportsData } from '../api/types';
import { useRecentAuthentication } from '../auth/confirm-identity';
import { errorText } from '../i18n/errors';
import { formatDateTime } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import { problemText } from '../products/product-form';
import { useAdminMutation, useAdminQuery, useShop, useShopTimezone } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, Card, ErrorState, Loading } from '../ui/feedback';
import { BackToSettings } from './settings-page';

/** How often the page asks again while an export is being made. */
const WHILE_MAKING_MS = 5000;

/** "830 KB", "2.4 MB": a file's size as people read it. */
export function sizeText(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** One export: when it was asked for, and whether it is being made, ready, failed or let go. */
function ExportRow({ item, timezone }: { item: StoreExport; timezone: string }) {
  const { t, locale } = useLocale();
  const when = (iso: string) => formatDateTime(iso, timezone, locale);
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3">
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="font-medium">
          {t('storeExport.asked', { date: when(item.createdAt) })}
        </span>
        <span
          className={
            item.status === 'FAILED'
              ? 'text-danger'
              : 'text-secondary text-[length:var(--hatti-type-body-sm-size)]'
          }
        >
          {item.status === 'PENDING'
            ? t('storeExport.pending')
            : item.status === 'READY'
              ? t('storeExport.ready', {
                  size: sizeText(item.size ?? 0),
                  date: when(item.expiresAt ?? item.createdAt),
                })
              : item.status === 'FAILED'
                ? t('storeExport.failed', { error: item.error ?? '' })
                : t('storeExport.expired')}
        </span>
      </span>
      {item.status === 'READY' && item.url && (
        <a
          href={item.url}
          download
          className="inline-flex min-h-10 items-center gap-2 rounded-control border border-line px-3 font-medium"
        >
          <Download aria-hidden className="size-5" />
          {t('storeExport.download')}
        </a>
      )}
    </li>
  );
}

/** The owner's own: the exports asked for, and the button that asks for another. */
function OwnerExports() {
  const { t } = useLocale();
  const timezone = useShopTimezone();
  // Asked again while one is being made, so that it shows ready without a reload.
  const query = useAdminQuery<StoreExportsData>(['storeExports'], StoreExportsQuery, undefined, {
    refetchInterval: (data) =>
      data?.storeExports.some((item) => item.status === 'PENDING') ? WHILE_MAKING_MS : false,
  });
  const create = useAdminMutation<StoreExportCreateData, Record<string, never>>(
    StoreExportCreateMutation,
  );
  const { run, panel } = useRecentAuthentication();
  const [problem, setProblem] = useState<string | null>(null);

  const onAsk = () => {
    setProblem(null);
    void run(
      async () => {
        const { storeExportCreate } = await create.mutateAsync({});
        const error = storeExportCreate.userErrors[0];
        if (error) setProblem(problemText(error, t));
      },
      (failure) => setProblem(errorText(failure, t)),
    );
  };

  if (query.isPending) return <Loading label={t('state.loading')} />;
  if (query.isError) {
    return (
      <ErrorState
        message={errorText(query.error, t)}
        action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
      />
    );
  }
  const exports = query.data.storeExports;
  return (
    <>
      <Card className="flex flex-col gap-3 p-4">
        <p className="text-secondary">{t('storeExport.hint')}</p>
        <Alert tone="warning">{t('storeExport.safe')}</Alert>
        {problem && <Alert tone="danger">{problem}</Alert>}
        <Button
          className="self-start"
          busy={create.isPending}
          disabled={exports.some((item) => item.status === 'PENDING')}
          icon={<Archive aria-hidden className="size-5" />}
          onClick={onAsk}
        >
          {t('storeExport.ask')}
        </Button>
        {panel}
      </Card>
      <section aria-labelledby="store-exports" className="flex flex-col gap-2">
        <h2 id="store-exports" className="font-semibold">
          {t('storeExport.history')}
        </h2>
        {exports.length === 0 ? (
          <p className="text-secondary">{t('storeExport.none')}</p>
        ) : (
          <Card>
            <ul className="divide-y divide-line">
              {exports.map((item) => (
                <ExportRow key={item.id} item={item} timezone={timezone} />
              ))}
            </ul>
          </Card>
        )}
      </section>
    </>
  );
}

/**
 * The whole store exported (ADM-10, ADR-415): the owner asks, and a ZIP of each part's own
 * export is ready in a few minutes, downloaded for a week. Managers open settings too, and are
 * told it is the owner's.
 */
export function StoreExportPage() {
  const { t } = useLocale();
  const { role } = useShop();
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 pb-8">
      <BackToSettings />
      <h1 className="text-[length:var(--hatti-type-display-size)] font-semibold">
        {t('settings.export')}
      </h1>
      {role === 'owner' ? (
        <OwnerExports />
      ) : (
        <Card className="p-4">
          <p className="text-secondary">{t('storeExport.ownerOnly')}</p>
        </Card>
      )}
    </div>
  );
}
