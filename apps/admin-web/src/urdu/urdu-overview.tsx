/** What of the shop's is in Urdu and what is left to write, kind by kind (OS-06). */
import { Link } from '@tanstack/react-router';
import { ChevronRight, CircleCheck } from 'lucide-react';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { UrduOverviewQuery } from '../api/operations';
import type { UrduKind, UrduOverviewData, UrduResource } from '../api/types';
import { errorText } from '../i18n/errors';
import { useLocale } from '../i18n/locale';
import type { Translate } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { CheckField, SelectField } from '../settings/settings-form';
import { useAdminQuery, useShop } from '../shell/shop-context';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Alert, Card, EmptyState, Loading } from '../ui/feedback';
import { urduBadges } from './in-urdu';
import type { UrduCount } from './in-urdu';

export const URDU_KINDS: readonly UrduKind[] = [
  'PRODUCT',
  'COLLECTION',
  'ONLINE_STORE_PAGE',
  'ONLINE_STORE_BLOG',
  'ONLINE_STORE_ARTICLE',
  'MENU',
  'SHOP',
];

/** How many are listed at first, and the most the core lists at once. */
const FIRST = 100;
const MOST = 250;

/** How much of a thing's own words are in Urdu: its fields with words, those written, and those out of date. */
export function urduCount(resource: UrduResource): UrduCount {
  const keys = new Set(
    resource.translatableContent
      .filter((content) => content.digest && content.value)
      .map((content) => content.key),
  );
  const written = resource.translations.filter(
    (translation) => keys.has(translation.key) && (translation.value ?? '').trim() !== '',
  );
  return {
    total: keys.size,
    written: written.length,
    outdated: written.filter((translation) => translation.outdated).length,
  };
}

/** Whether something has words still to write in Urdu, or Urdu to check. */
const left = (count: UrduCount) => count.written < count.total || count.outdated > 0;

function nameOf(kind: UrduKind, resource: UrduResource, t: Translate): string {
  if (kind === 'SHOP') return t('urdu.homePageName');
  const title = resource.translatableContent.find((content) => content.key === 'title')?.value;
  return title?.trim() || t('urduAll.untitled');
}

const ROW = 'flex flex-wrap items-center gap-2 px-4 py-3 hover:bg-canvas';

/** A link to where the Urdu of a thing of `kind` is written. */
function UrduLink({ kind, id, children }: { kind: UrduKind; id: string; children: ReactNode }) {
  const shopId = useShop().id;
  switch (kind) {
    case 'PRODUCT':
      return (
        <Link
          to="/$shopId/products/$productId/urdu"
          params={{ shopId, productId: id }}
          className={ROW}
        >
          {children}
        </Link>
      );
    case 'COLLECTION':
      return (
        <Link
          to="/$shopId/collections/$collectionId/urdu"
          params={{ shopId, collectionId: id }}
          className={ROW}
        >
          {children}
        </Link>
      );
    case 'ONLINE_STORE_PAGE':
      return (
        <Link
          to="/$shopId/online-store/pages/$pageId/urdu"
          params={{ shopId, pageId: id }}
          className={ROW}
        >
          {children}
        </Link>
      );
    case 'ONLINE_STORE_BLOG':
      return (
        <Link
          to="/$shopId/online-store/blogs/$blogId/urdu"
          params={{ shopId, blogId: id }}
          className={ROW}
        >
          {children}
        </Link>
      );
    case 'ONLINE_STORE_ARTICLE':
      return (
        <Link
          to="/$shopId/online-store/articles/$articleId/urdu"
          params={{ shopId, articleId: id }}
          className={ROW}
        >
          {children}
        </Link>
      );
    case 'MENU':
      return (
        <Link
          to="/$shopId/online-store/menus/$menuId/urdu"
          params={{ shopId, menuId: id }}
          className={ROW}
        >
          {children}
        </Link>
      );
    case 'SHOP':
      return (
        <Link to="/$shopId/online-store/home-page/urdu" params={{ shopId }} className={ROW}>
          {children}
        </Link>
      );
  }
}

/** The things of one kind, the newest first, each with how much of it is in Urdu. */
function KindList({ kind, leftOnly }: { kind: UrduKind; leftOnly: boolean }) {
  const { t } = useLocale();
  const [first, setFirst] = useState(FIRST);
  const query = useAdminQuery<UrduOverviewData>(
    ['urduOverview', kind],
    UrduOverviewQuery,
    { type: kind, first },
    { keepPrevious: true },
  );

  if (query.isPending) return <Loading label={t('state.loading')} />;
  if (query.isError) return <Alert tone="danger">{errorText(query.error, t)}</Alert>;
  const { nodes, pageInfo } = query.data.translatableResources;
  // Those without words of their own have nothing to put in Urdu.
  const things = nodes
    .map((node) => ({ node, count: urduCount(node) }))
    .filter(({ count }) => count.total > 0);
  const done = things.filter(({ count }) => !left(count)).length;
  const shown = leftOnly ? things.filter(({ count }) => left(count)) : things;

  return (
    <div className="flex flex-col gap-3">
      {things.length > 0 && (
        <p className="text-secondary">
          {t(pageInfo.hasNextPage ? 'urduAll.summaryNewest' : 'urduAll.summary', {
            done: String(done),
            count: String(things.length),
          })}
        </p>
      )}
      {things.length === 0 ? (
        <Card>
          <EmptyState title={t('urduAll.none')} />
        </Card>
      ) : shown.length === 0 ? (
        <Card>
          <EmptyState
            icon={<CircleCheck aria-hidden className="size-8 text-success" />}
            title={t('urduAll.allDone')}
          />
        </Card>
      ) : (
        <Card>
          <ul className="divide-y divide-line">
            {shown.map(({ node, count }) => (
              <li key={node.resourceId}>
                <UrduLink kind={kind} id={node.resourceId}>
                  <span className="min-w-0 flex-1 font-medium" dir="auto">
                    {nameOf(kind, node, t)}
                  </span>
                  {urduBadges(count, t).map((badge) => (
                    <Badge key={badge.label} {...badge} />
                  ))}
                  <ChevronRight aria-hidden className="size-5 text-secondary rtl:rotate-180" />
                </UrduLink>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {pageInfo.hasNextPage &&
        (first < MOST ? (
          <Button
            variant="tertiary"
            className="self-start"
            busy={query.isFetching}
            onClick={() => setFirst(MOST)}
          >
            {t('orders.more')}
          </Button>
        ) : (
          <p className="text-secondary">{t('urduAll.newest', { count: String(MOST) })}</p>
        ))}
    </div>
  );
}

/**
 * The online store's Urdu (OS-06, ADR-238): the shop's products, collections, pages, blogs,
 * articles and menus, and its home page, kind by kind, the newest first, each with how much of its
 * own words its Urdu pages show in Urdu and how much was written for words since changed; at first
 * only those with something left to write or check, each opening where its Urdu is written.
 */
export function UrduOverview() {
  const { t } = useLocale();
  const [kind, setKind] = useState<UrduKind>('PRODUCT');
  const [leftOnly, setLeftOnly] = useState(true);
  return (
    <div className="flex flex-col gap-4">
      <p className="text-secondary">{t('urduAll.hint')}</p>
      <div className="flex flex-col gap-3 md:flex-row md:items-end">
        <SelectField<UrduKind>
          label={t('urduAll.show')}
          value={kind}
          options={URDU_KINDS.map((each) => ({
            value: each,
            label: t(`urduAll.kind.${each}` as MessageKey),
          }))}
          onChange={setKind}
        />
        <CheckField label={t('urduAll.leftOnly')} checked={leftOnly} onChange={setLeftOnly} />
      </div>
      <KindList key={kind} kind={kind} leftOnly={leftOnly} />
    </div>
  );
}
