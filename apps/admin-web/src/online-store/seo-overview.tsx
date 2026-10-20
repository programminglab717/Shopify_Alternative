/** Every page's search engine listing in one place, those without a description first (OS-09). */
import { Link } from '@tanstack/react-router';
import { CircleAlert, CircleCheck, FileQuestion, ImageOff, Scissors } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useState } from 'react';
import type { ReactNode } from 'react';
import {
  SeoArticlesQuery,
  SeoBlogsQuery,
  SeoCollectionsQuery,
  SeoPagesQuery,
  SeoProductsQuery,
} from '../api/operations';
import type { SeoKind, SeoListed, SeoListingsData } from '../api/types';
import { gate, permits, type Gate } from '../auth/permissions';
import { errorText } from '../i18n/errors';
import { useLocale } from '../i18n/locale';
import type { Translate } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { EDITS_PRODUCTS } from '../products/status';
import { CheckField, SelectField } from '../settings/settings-form';
import { useAdminQuery, useShop } from '../shell/shop-context';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Alert, Card, EmptyState, Loading } from '../ui/feedback';
import { WRITES_BLOGS, WRITES_PAGES } from './pages';
import { DESCRIPTION_SHOWN, SearchListingPreview, TITLE_SHOWN, excerpt } from './search-listing';

/** Each kind, who keeps it, the query that lists it, and its path at the storefront. */
const KINDS: Record<SeoKind, { gate: Gate; query: string; path: (listed: SeoListed) => string }> = {
  PRODUCT: {
    gate: EDITS_PRODUCTS,
    query: SeoProductsQuery,
    path: (listed) => `/products/${listed.handle}`,
  },
  COLLECTION: {
    gate: EDITS_PRODUCTS,
    query: SeoCollectionsQuery,
    path: (listed) => `/collections/${listed.handle}`,
  },
  PAGE: { gate: WRITES_PAGES, query: SeoPagesQuery, path: (listed) => `/pages/${listed.handle}` },
  BLOG: { gate: WRITES_BLOGS, query: SeoBlogsQuery, path: (listed) => `/blogs/${listed.handle}` },
  ARTICLE: {
    gate: WRITES_BLOGS,
    query: SeoArticlesQuery,
    path: (listed) => `/blogs/${listed.blog?.handle ?? ''}/${listed.handle}`,
  },
};

export const SEO_KINDS: readonly SeoKind[] = ['PRODUCT', 'COLLECTION', 'PAGE', 'BLOG', 'ARTICLE'];

/** Those who keep the listings of any kind the tab lists. */
export const KEEPS_LISTINGS = gate(
  [...new Set(SEO_KINDS.flatMap((kind) => KINDS[kind].gate.roles))],
  (shop) => SEO_KINDS.some((kind) => permits(shop, KINDS[kind].gate)),
);

/** How many are listed at first, and the most the core lists at once. */
const FIRST = 100;
const MOST = 250;

/** What a listing's page says of itself, which the storefront describes it by when the shop doesn't (ADR-231). */
function ownTextOf(listed: SeoListed): string {
  return listed.summary || listed.description || listed.body || '';
}

/**
 * What is wrong with a listing, worst first: nothing to describe it, no description of its own,
 * words cut short, images that say nothing of what they show (ADR-618).
 */
export type ListingProblem =
  'NOTHING' | 'NO_DESCRIPTION' | 'TITLE_CUT' | 'DESCRIPTION_CUT' | 'IMAGES';

/** The images in `html` without words for what they show: no `alt`, or one of only spaces. */
function undescribedIn(html: string | undefined): number {
  if (!html || !html.includes('<img')) return 0;
  const images = new DOMParser().parseFromString(html, 'text/html').querySelectorAll('img');
  return [...images].filter((image) => !(image.getAttribute('alt') ?? '').trim()).length;
}

/**
 * How many of a listing's images say nothing of what they show (ADR-618), which search engines'
 * image results and screen readers go by: a product's photos, an article's image (its file's
 * words standing for its own), and the images in a page's or an article's text.
 */
export function undescribedImagesOf(listed: SeoListed): number {
  const photos = (listed.media ?? []).filter(
    (media) => media.mediaContentType === 'IMAGE' && !media.alt.trim(),
  ).length;
  const image = listed.image && !listed.image.alt.trim() ? 1 : 0;
  return photos + image + undescribedIn(listed.body) + undescribedIn(listed.summary ?? undefined);
}

export function problemsOf(listed: SeoListed): ListingProblem[] {
  const own = (listed.seo.description ?? '').trim();
  const title = (listed.seo.title ?? '').trim() || listed.title;
  const description = own || excerpt(ownTextOf(listed), Number.MAX_SAFE_INTEGER);
  const problems: ListingProblem[] = [];
  if (!own) problems.push(description ? 'NO_DESCRIPTION' : 'NOTHING');
  if (Array.from(title).length > TITLE_SHOWN) problems.push('TITLE_CUT');
  if (own && Array.from(own).length > DESCRIPTION_SHOWN) problems.push('DESCRIPTION_CUT');
  if (undescribedImagesOf(listed) > 0) problems.push('IMAGES');
  return problems;
}

const BADGES: Record<
  ListingProblem,
  { colour: 'deliveryIssue' | 'needsConfirmation' | 'cancelled'; icon: LucideIcon }
> = {
  NOTHING: { colour: 'deliveryIssue', icon: CircleAlert },
  NO_DESCRIPTION: { colour: 'needsConfirmation', icon: FileQuestion },
  TITLE_CUT: { colour: 'cancelled', icon: Scissors },
  DESCRIPTION_CUT: { colour: 'cancelled', icon: Scissors },
  IMAGES: { colour: 'needsConfirmation', icon: ImageOff },
};

/** What a badge says of a problem; of images, how many. */
function problemLabel(problem: ListingProblem, listed: SeoListed, t: Translate): string {
  return problem === 'IMAGES'
    ? t('seoAll.problem.IMAGES', { count: undescribedImagesOf(listed) })
    : t(`seoAll.problem.${problem}` as MessageKey);
}

/** What the tab shows at first: those without a description, or with images without one. */
function needsWork(problems: readonly ListingProblem[]): boolean {
  return problems.some(
    (problem) => problem === 'NOTHING' || problem === 'NO_DESCRIPTION' || problem === 'IMAGES',
  );
}

const ROW = 'flex flex-col gap-2 px-4 py-3 hover:bg-canvas';

/** A link to where a listing of `kind` is written: the page that keeps the thing. */
function ListingLink({ kind, id, children }: { kind: SeoKind; id: string; children: ReactNode }) {
  const shopId = useShop().id;
  switch (kind) {
    case 'PRODUCT':
      return (
        <Link to="/$shopId/products/$productId" params={{ shopId, productId: id }} className={ROW}>
          {children}
        </Link>
      );
    case 'COLLECTION':
      return (
        <Link
          to="/$shopId/collections/$collectionId"
          params={{ shopId, collectionId: id }}
          className={ROW}
        >
          {children}
        </Link>
      );
    case 'PAGE':
      return (
        <Link
          to="/$shopId/online-store/pages/$pageId"
          params={{ shopId, pageId: id }}
          className={ROW}
        >
          {children}
        </Link>
      );
    case 'BLOG':
      return (
        <Link
          to="/$shopId/online-store/blogs/$blogId"
          params={{ shopId, blogId: id }}
          className={ROW}
        >
          {children}
        </Link>
      );
    case 'ARTICLE':
      return (
        <Link
          to="/$shopId/online-store/articles/$articleId"
          params={{ shopId, articleId: id }}
          className={ROW}
        >
          {children}
        </Link>
      );
  }
}

function nameOf(listed: SeoListed, t: Translate): string {
  return listed.title.trim() || t('seoAll.untitled');
}

/** The listings of one kind, each with how a search engine shows it and what is wrong with it. */
function KindList({ kind, missingOnly }: { kind: SeoKind; missingOnly: boolean }) {
  const { t } = useLocale();
  const [first, setFirst] = useState(FIRST);
  const query = useAdminQuery<SeoListingsData>(
    ['seoListings', kind],
    KINDS[kind].query,
    { first },
    { keepPrevious: true },
  );

  if (query.isPending) return <Loading label={t('state.loading')} />;
  if (query.isError) return <Alert tone="danger">{errorText(query.error, t)}</Alert>;
  const { nodes, pageInfo } = query.data.listed;
  const storefront = query.data.shop?.url ?? '';
  const listings = nodes.map((listed) => ({ listed, problems: problemsOf(listed) }));
  const missing = listings.filter(({ problems }) =>
    problems.some((problem) => problem === 'NOTHING' || problem === 'NO_DESCRIPTION'),
  );
  const imageless = listings.filter(({ problems }) => problems.includes('IMAGES'));
  const shown = missingOnly ? listings.filter(({ problems }) => needsWork(problems)) : listings;

  return (
    <div className="flex flex-col gap-3">
      {listings.length > 0 && (
        <p className="text-secondary">
          {t(pageInfo.hasNextPage ? 'seoAll.summaryFirst' : 'seoAll.summary', {
            missing: String(missing.length),
            count: String(listings.length),
          })}
        </p>
      )}
      {imageless.length > 0 && (
        <p className="text-secondary">{t('seoAll.imagesSummary', { count: imageless.length })}</p>
      )}
      {listings.length === 0 ? (
        <Card>
          <EmptyState title={t('seoAll.none')} />
        </Card>
      ) : shown.length === 0 ? (
        <Card>
          <EmptyState
            icon={<CircleCheck aria-hidden className="size-8 text-success" />}
            title={t('seoAll.allDone')}
          />
        </Card>
      ) : (
        <Card>
          <ul className="divide-y divide-line">
            {shown.map(({ listed, problems }) => (
              <li key={listed.id}>
                <ListingLink kind={kind} id={listed.id}>
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="min-w-0 flex-1 font-medium" dir="auto">
                      {nameOf(listed, t)}
                    </span>
                    {problems.map((problem) => (
                      <Badge
                        key={problem}
                        {...BADGES[problem]}
                        label={problemLabel(problem, listed, t)}
                      />
                    ))}
                  </span>
                  <SearchListingPreview
                    url={`${storefront}${KINDS[kind].path(listed)}`}
                    title={(listed.seo.title ?? '').trim() || listed.title}
                    description={(listed.seo.description ?? '').trim() || ownTextOf(listed)}
                  />
                </ListingLink>
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
          <p className="text-secondary">{t('seoAll.first', { count: String(MOST) })}</p>
        ))}
    </div>
  );
}

/**
 * The online store's search listings (OS-09, ADR-606): the shop's products, collections, pages,
 * blogs and articles kind by kind, each as a search engine lists it, with those that have no
 * description of their own, or nothing to make one from, and the words engines cut short; at
 * first only those without a description, each opening the page where its listing is written.
 */
export function SeoOverview() {
  const { t } = useLocale();
  const shop = useShop();
  const kinds = SEO_KINDS.filter((kind) => permits(shop, KINDS[kind].gate));
  const [kind, setKind] = useState<SeoKind>(kinds[0] ?? 'PRODUCT');
  const [missingOnly, setMissingOnly] = useState(true);
  return (
    <div className="flex flex-col gap-4">
      <p className="text-secondary">{t('seoAll.hint')}</p>
      <div className="flex flex-col gap-3 md:flex-row md:items-end">
        <SelectField<SeoKind>
          label={t('seoAll.show')}
          value={kind}
          options={kinds.map((each) => ({
            value: each,
            label: t(`seoAll.kind.${each}` as MessageKey),
          }))}
          onChange={setKind}
        />
        <CheckField
          label={t('seoAll.missingOnly')}
          checked={missingOnly}
          onChange={setMissingOnly}
        />
      </div>
      <KindList key={kind} kind={kind} missingOnly={missingOnly} />
    </div>
  );
}
