import { Link, useParams } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import type { ReactNode } from 'react';
import { CollectionQuery, PageQuery, ProductQuery } from '../api/operations';
import type { CollectionData, PageData, ProductData, ProductDetail } from '../api/types';
import { errorText } from '../i18n/errors';
import { useLocale } from '../i18n/locale';
import type { Translate } from '../i18n/locale';
import { useAdminQuery, useShop } from '../shell/shop-context';
import { Button } from '../ui/button';
import { EmptyState, ErrorState, Loading } from '../ui/feedback';
import { URDU_LINK, UrduSummary, UrduWords, WRITES_URDU, type UrduSection } from './in-urdu';

/** A product's words in Urdu: its own fields, then its options, each with its values. */
export function productInUrdu(
  product: Pick<ProductDetail, 'id' | 'options'>,
  t: Translate,
): UrduSection[] {
  return [
    { title: t('urdu.product'), things: [{ id: product.id, kind: 'product' }] },
    {
      title: t('urdu.options'),
      hint: t('urdu.optionsHint'),
      things: product.options.flatMap((option) => [
        { id: option.id, kind: 'option' as const },
        ...option.optionValues.map((value) => ({ id: value.id, kind: 'value' as const })),
      ]),
    },
  ];
}

const collectionInUrdu = (id: string, t: Translate): UrduSection[] => [
  { title: t('urdu.collection'), things: [{ id, kind: 'collection' }] },
];

const pageInUrdu = (id: string, t: Translate): UrduSection[] => [
  { title: t('urdu.page'), things: [{ id, kind: 'page' }] },
];

const BACK =
  'inline-flex min-h-10 max-w-full items-center gap-1 self-start text-secondary hover:text-text';

/**
 * The page of something's Urdu (OS-06): its name and what its Urdu does, then its fields beside
 * their Urdu, for those who write the shop's Urdu.
 */
function UrduPage({
  back,
  name,
  sections,
}: {
  back: ReactNode;
  name: string;
  sections: readonly UrduSection[];
}) {
  const { t } = useLocale();
  const { role } = useShop();
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 pb-8">
      {back}
      <div className="flex flex-col gap-1">
        <h1 className="text-[length:var(--hatti-type-display-size)] font-semibold" dir="auto">
          {t('urdu.title', { name })}
        </h1>
        <p className="text-secondary">{t('urdu.intro')}</p>
      </div>
      {WRITES_URDU.includes(role) ? (
        <UrduWords sections={sections} />
      ) : (
        <EmptyState title={t('urdu.cannot')} />
      )}
    </div>
  );
}

/** What a page shows while what it is about loads, cannot be read, or is not the shop's. */
function Waiting({
  query,
  missing,
}: {
  query: { isPending: boolean; isError: boolean; error: unknown; refetch: () => unknown };
  missing: string;
}) {
  const { t } = useLocale();
  if (query.isPending) return <Loading label={t('state.loading')} />;
  if (query.isError) {
    return (
      <ErrorState
        message={errorText(query.error, t)}
        action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
      />
    );
  }
  return <EmptyState title={missing} />;
}

/** A product's title, description, type, words for search engines and options in Urdu. */
export function ProductUrduPage() {
  const { t } = useLocale();
  const { id: shopId } = useShop();
  const { productId } = useParams({ from: '/$shopId/products/$productId/urdu' });
  const query = useAdminQuery<ProductData>(['product', productId], ProductQuery, {
    id: productId,
  });
  const product = query.data?.product;
  if (!product) return <Waiting query={query} missing={t('product.notFound')} />;
  return (
    <UrduPage
      back={
        <Link to="/$shopId/products/$productId" params={{ shopId, productId }} className={BACK}>
          <ArrowLeft aria-hidden className="size-5 shrink-0 rtl:rotate-180" />
          <span className="truncate" dir="auto">
            {product.title}
          </span>
        </Link>
      }
      name={product.title}
      sections={productInUrdu(product, t)}
    />
  );
}

/** A collection's title, description and words for search engines in Urdu. */
export function CollectionUrduPage() {
  const { t } = useLocale();
  const { id: shopId } = useShop();
  const { collectionId } = useParams({ from: '/$shopId/collections/$collectionId/urdu' });
  const query = useAdminQuery<CollectionData>(['collection', collectionId], CollectionQuery, {
    id: collectionId,
  });
  const collection = query.data?.collection;
  if (!collection) return <Waiting query={query} missing={t('collection.notFound')} />;
  return (
    <UrduPage
      back={
        <Link
          to="/$shopId/collections/$collectionId"
          params={{ shopId, collectionId }}
          className={BACK}
        >
          <ArrowLeft aria-hidden className="size-5 shrink-0 rtl:rotate-180" />
          <span className="truncate" dir="auto">
            {collection.title}
          </span>
        </Link>
      }
      name={collection.title}
      sections={collectionInUrdu(collection.id, t)}
    />
  );
}

/** A page's title, text and words for search engines in Urdu. */
export function PageUrduPage() {
  const { t } = useLocale();
  const { id: shopId } = useShop();
  const { pageId } = useParams({ from: '/$shopId/online-store/pages/$pageId/urdu' });
  const query = useAdminQuery<PageData>(['page', pageId], PageQuery, { id: pageId });
  const page = query.data?.page;
  if (!page) return <Waiting query={query} missing={t('pages.notFound')} />;
  return (
    <UrduPage
      back={
        <Link to="/$shopId/online-store/pages/$pageId" params={{ shopId, pageId }} className={BACK}>
          <ArrowLeft aria-hidden className="size-5 shrink-0 rtl:rotate-180" />
          <span className="truncate" dir="auto">
            {page.title}
          </span>
        </Link>
      }
      name={page.title}
      sections={pageInUrdu(page.id, t)}
    />
  );
}

/** How much of a product is in Urdu, on its page, and the way to its Urdu. */
export function ProductUrduCard({ product }: { product: ProductDetail }) {
  const { t } = useLocale();
  const { id: shopId, role } = useShop();
  if (!WRITES_URDU.includes(role)) return null;
  return (
    <UrduSummary
      sections={productInUrdu(product, t)}
      link={(children) => (
        <Link
          to="/$shopId/products/$productId/urdu"
          params={{ shopId, productId: product.id }}
          className={URDU_LINK}
        >
          {children}
        </Link>
      )}
    />
  );
}

/** How much of a collection is in Urdu, on its page, and the way to its Urdu. */
export function CollectionUrduCard({ collectionId }: { collectionId: string }) {
  const { t } = useLocale();
  const { id: shopId, role } = useShop();
  if (!WRITES_URDU.includes(role)) return null;
  return (
    <UrduSummary
      sections={collectionInUrdu(collectionId, t)}
      link={(children) => (
        <Link
          to="/$shopId/collections/$collectionId/urdu"
          params={{ shopId, collectionId }}
          className={URDU_LINK}
        >
          {children}
        </Link>
      )}
    />
  );
}

/** How much of a page is in Urdu, on its page, and the way to its Urdu. */
export function PageUrduCard({ pageId }: { pageId: string }) {
  const { t } = useLocale();
  const { id: shopId, role } = useShop();
  if (!WRITES_URDU.includes(role)) return null;
  return (
    <UrduSummary
      sections={pageInUrdu(pageId, t)}
      link={(children) => (
        <Link
          to="/$shopId/online-store/pages/$pageId/urdu"
          params={{ shopId, pageId }}
          className={URDU_LINK}
        >
          {children}
        </Link>
      )}
    />
  );
}
