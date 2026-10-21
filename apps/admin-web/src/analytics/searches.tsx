/** What shoppers search the online store for (SRC-06, ADR-684). */
import { Link } from '@tanstack/react-router';
import { Plus } from 'lucide-react';
import { StoreSearchesQuery } from '../api/operations';
import type { StoreSearchesData, StoreSearchTermsValue } from '../api/types';
import { errorText } from '../i18n/errors';
import { formatCount } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { FormSection } from '../products/product-form';
import { permits } from '../auth/permissions';
import { EDITS_PRODUCTS } from '../products/status';
import { useAdminQuery, useShop } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Card, ErrorState, Loading } from '../ui/feedback';
import type { Days } from './period';
import { percentOne } from './visits';

/** A count of the period's searches, under its label. */
function Count({ label, shown }: { label: MessageKey; shown: string }) {
  const { t } = useLocale();
  return (
    <Card className="flex flex-col gap-1 p-4">
      <span className="text-secondary">{t(label)}</span>
      <span className="num text-[length:var(--hatti-type-title-size)] font-semibold">{shown}</span>
    </Card>
  );
}

/**
 * Searches by their words, each opening the products list searched for them, to see what the
 * shop has for them; with how often, and of those how often they found nothing.
 */
function Terms({
  rows,
  count,
  synonym = false,
}: {
  rows: readonly StoreSearchTermsValue[];
  count: (row: StoreSearchTermsValue) => string;
  /** Whether each offers a synonym group begun with its words (ADR-686). */
  synonym?: boolean;
}) {
  const { t } = useLocale();
  const shop = useShop();
  return (
    <ol className="flex flex-col divide-y divide-line">
      {rows.map((row) => (
        <li key={row.terms} className="flex items-baseline gap-3 py-2">
          <Link
            to="/$shopId/products"
            params={{ shopId: shop.id }}
            search={{ q: row.terms }}
            className="min-w-0 flex-1 break-words underline-offset-4 hover:underline"
            dir="auto"
          >
            {row.terms}
          </Link>
          <span className="num text-secondary">{count(row)}</span>
          {synonym && (
            <Link
              to="/$shopId/online-store"
              params={{ shopId: shop.id }}
              search={{ tab: 'synonyms', word: row.terms }}
              aria-label={t('searches.addSynonym', { terms: row.terms })}
              className="inline-flex min-h-10 items-center gap-1 text-primary underline-offset-4 hover:underline"
            >
              <Plus aria-hidden className="size-4" />
              {t('searches.addSynonymShort')}
            </Link>
          )}
        </li>
      ))}
    </ol>
  );
}

/**
 * The online store's searches over the period the page shows, as shoppers' pages reported them
 * (ADR-683): how many, the share that found nothing, the most searched, and those that most
 * often found nothing, which say what to add or what words the shop's products lack.
 */
export function Searches({ days }: { days: Days }) {
  const { t } = useLocale();
  const shop = useShop();
  const query = useAdminQuery<StoreSearchesData>(['storeSearches', days], StoreSearchesQuery, {
    days,
  });

  let body;
  if (query.isPending) body = <Loading label={t('state.loading')} />;
  else if (query.isError) {
    body = (
      <ErrorState
        message={errorText(query.error, t)}
        action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
      />
    );
  } else {
    const report = query.data.storeSearches;
    body =
      report.searches === 0 ? (
        <Card>
          <p className="p-4 text-secondary">{t('searches.none')}</p>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3">
            <Count label="searches.searches" shown={formatCount(report.searches)} />
            <Count label="searches.foundNothingShare" shown={percentOne(report.foundNothingRate)} />
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <FormSection title={t('searches.top')}>
              <Terms
                rows={report.top}
                count={(row) => t('searches.times', { count: formatCount(row.searches) })}
              />
            </FormSection>
            <FormSection title={t('searches.nothingFound')} hint={t('searches.nothingFoundHint')}>
              {report.nothingFound.length === 0 ? (
                <p className="text-secondary">{t('searches.allFound')}</p>
              ) : (
                <Terms
                  rows={report.nothingFound}
                  count={(row) => t('searches.times', { count: formatCount(row.foundNothing) })}
                  synonym={permits(shop, EDITS_PRODUCTS)}
                />
              )}
            </FormSection>
          </div>
        </>
      );
  }

  return (
    <section aria-labelledby="analytics-searches" className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 id="analytics-searches" className="font-semibold">
          {t('searches.title')}
        </h2>
        <p className="text-secondary">{t('searches.hint')}</p>
      </div>
      {body}
    </section>
  );
}
