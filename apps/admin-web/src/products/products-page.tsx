import { useInfiniteQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import {
  ChevronRight,
  FileSpreadsheet,
  FolderOpen,
  FolderPlus,
  PackageOpen,
  Plus,
  Search,
  Tags,
  ToggleRight,
  Trash2,
} from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { ProductsQuery } from '../api/operations';
import type { ProductListItem, ProductStatus, ProductsData } from '../api/types';
import { useSessionStore } from '../auth/context';
import { errorText } from '../i18n/errors';
import { formatCount } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import type { BulkOutcome } from '../orders/bulk';
import { SavedSearches } from '../shell/saved-searches';
import { useShop } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, Card, EmptyState, ErrorState, Loading } from '../ui/feedback';
import { CollectionPanel, DeletePanel, ProductTagsPanel, StatusPanel } from './bulk';
import {
  EDITS_PRODUCTS,
  PRODUCT_STATUSES,
  ProductStatusBadge,
  ProductThumb,
  priceRange,
} from './status';

const TABS: readonly (ProductStatus | null)[] = [null, 'ACTIVE', 'DRAFT', 'ARCHIVED'];

const PAGE = 50;

/** The products list's search: a status tab and the words searched for. */
export interface ProductsSearch {
  status?: ProductStatus;
  q?: string;
}

export function validateProductsSearch(search: Record<string, unknown>): ProductsSearch {
  const status =
    typeof search.status === 'string' && search.status in PRODUCT_STATUSES
      ? (search.status as ProductStatus)
      : undefined;
  const q = typeof search.q === 'string' && search.q.trim() ? search.q.trim() : undefined;
  return { status, q };
}

/** How much of a product is in stock, as a line under its title. */
function Stock({ product }: { product: ProductListItem }) {
  const { t } = useLocale();
  const variants = product.variants.length;
  if (!product.tracksInventory) return <span>{t('products.notTracked')}</span>;
  const stock =
    product.totalInventory > 0 ? (
      <span>{t('products.inStock', { count: formatCount(product.totalInventory) })}</span>
    ) : (
      <span className="text-danger">{t('products.outOfStock')}</span>
    );
  return variants > 1 ? (
    <span>
      {stock} {t('products.across', { count: formatCount(variants) })}
    </span>
  ) : (
    stock
  );
}

function ProductRow({
  product,
  selectable,
  selected,
  onSelect,
}: {
  product: ProductListItem;
  selectable: boolean;
  selected: boolean;
  onSelect: (selected: boolean) => void;
}) {
  const { t } = useLocale();
  const shopId = useShop().id;
  return (
    <li className="flex items-center gap-3 ps-4">
      {selectable && (
        <input
          type="checkbox"
          checked={selected}
          onChange={(event) => onSelect(event.target.checked)}
          aria-label={t('orders.select', { name: product.title })}
          className="size-5 shrink-0 accent-[var(--hatti-color-primary)]"
        />
      )}
      <Link
        to="/$shopId/products/$productId"
        params={{ shopId, productId: product.id }}
        className="flex min-w-0 flex-1 items-center gap-3 py-3 pe-4"
      >
        <ProductThumb media={product.media} />
        <span className="flex min-w-0 flex-1 flex-col gap-1 md:flex-row md:items-center md:gap-4">
          <span className="min-w-0 flex-1 truncate font-medium" dir="auto">
            {product.title}
          </span>
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-secondary text-[length:var(--hatti-type-body-sm-size)] md:w-56">
            <Stock product={product} />
          </span>
          <span className="flex items-center gap-3">
            <ProductStatusBadge status={product.status} />
            <span className="num font-medium md:w-40 md:text-end">
              {priceRange(product.priceRange.minVariantPrice, product.priceRange.maxVariantPrice)}
            </span>
          </span>
        </span>
        <ChevronRight
          aria-hidden
          className="hidden size-5 text-secondary md:block rtl:rotate-180"
        />
      </Link>
    </li>
  );
}

/** The bulk actions' panels, one open at a time. */
type Panel = 'status' | 'tags' | 'collection' | 'delete';

/**
 * The products list (CAT-04, docs/design/02 §2): a tab for each status, a search that knows Roman
 * Urdu spellings, newest first a page at a time; owners and managers add products from it, and
 * show, hide, tag, collect or delete those they choose on it at once.
 */
export function ProductsPage() {
  const { t } = useLocale();
  const store = useSessionStore();
  const shop = useShop();
  const navigate = useNavigate();
  const { status, q } = useSearch({ from: '/$shopId/products' });
  const [words, setWords] = useState(q ?? '');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [outcome, setOutcome] = useState<BulkOutcome | null>(null);
  const [panel, setPanel] = useState<Panel | null>(null);
  const query = [q, status && `status:${status.toLowerCase()}`].filter(Boolean).join(' ') || null;

  const products = useInfiniteQuery({
    queryKey: ['admin', shop.id, 'products', query],
    queryFn: ({ pageParam }) =>
      store.graphql<ProductsData>(shop.id, ProductsQuery, {
        first: PAGE,
        after: pageParam,
        query,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) =>
      last.products.pageInfo.hasNextPage ? last.products.pageInfo.endCursor : undefined,
  });

  const choose = (next: ProductsSearch) => {
    setSelected(new Set());
    setOutcome(null);
    setPanel(null);
    void navigate({ to: '/$shopId/products', params: { shopId: shop.id }, search: next });
  };

  const onSearch = (event: FormEvent) => {
    event.preventDefault();
    choose({ status, q: words.trim() || undefined });
  };

  const shown = products.data?.pages.flatMap((page) => page.products.nodes) ?? [];
  const edits = EDITS_PRODUCTS.includes(shop.role);
  const names = new Map(shown.map((product) => [product.id, product.title]));
  const ids = [...selected];

  const open = (next: Panel) => {
    setOutcome(null);
    setPanel(next);
  };

  /** A panel's bulk action done, or put away: what came of it said, the choice cleared. */
  const closePanel = (done: BulkOutcome | null) => {
    setPanel(null);
    if (done) {
      setOutcome(done);
      setSelected(new Set());
    }
  };

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-[length:var(--hatti-type-display-size)] font-semibold">
          {t('products.title')}
        </h1>
        <div className="flex flex-wrap items-center gap-2">
          <Link
            to="/$shopId/collections"
            params={{ shopId: shop.id }}
            className="inline-flex min-h-12 items-center gap-2 rounded-control border border-line bg-surface px-4 font-medium hover:bg-canvas md:min-h-10"
          >
            <FolderOpen aria-hidden className="size-5" />
            {t('collections.title')}
          </Link>
          {edits && (
            <Link
              to="/$shopId/products/files"
              params={{ shopId: shop.id }}
              className="inline-flex min-h-12 items-center gap-2 rounded-control border border-line bg-surface px-4 font-medium hover:bg-canvas md:min-h-10"
            >
              <FileSpreadsheet aria-hidden className="size-5" />
              {t('files.title')}
            </Link>
          )}
          {edits && (
            <Link
              to="/$shopId/products/new"
              params={{ shopId: shop.id }}
              className="inline-flex min-h-12 items-center gap-2 rounded-control bg-primary px-4 font-medium text-on-primary hover:bg-primary-strong md:min-h-10"
            >
              <Plus aria-hidden className="size-5" />
              {t('products.add')}
            </Link>
          )}
        </div>
      </div>
      <form onSubmit={onSearch} role="search" className="relative">
        <Search
          aria-hidden
          className="pointer-events-none absolute start-3 top-1/2 size-5 -translate-y-1/2 text-secondary"
        />
        <input
          type="search"
          value={words}
          onChange={(event) => setWords(event.target.value)}
          aria-label={t('products.search')}
          placeholder={t('products.searchHint')}
          className="min-h-12 w-full rounded-control border border-line bg-surface ps-10 pe-3 md:min-h-10"
        />
      </form>
      <SavedSearches
        resource="PRODUCT"
        query={q}
        manages={edits}
        onApply={(query) => {
          setWords(query ?? '');
          choose({ status, q: query });
        }}
      />
      <div role="tablist" className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 md:mx-0 md:px-0">
        {TABS.map((tab) => {
          const active = (tab ?? undefined) === status;
          return (
            <button
              key={tab ?? 'all'}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => choose({ status: tab ?? undefined, q })}
              className={`inline-flex min-h-10 shrink-0 items-center rounded-full border px-3 ${
                active
                  ? 'border-primary bg-primary text-on-primary'
                  : 'border-line bg-surface text-text'
              }`}
            >
              {tab ? t(PRODUCT_STATUSES[tab].label) : t('orders.all')}
            </button>
          );
        })}
      </div>
      {outcome && (
        <Alert tone={outcome.failed.length ? 'warning' : 'success'}>
          {outcome.done > 0 && <p>{t('productBulk.done', { count: outcome.done })}</p>}
          {outcome.failed.length > 0 && (
            <>
              <p>{t('orders.someFailed', { count: outcome.failed.length })}</p>
              <ul className="list-disc ps-5">
                {outcome.failed.map((message, index) => (
                  <li key={index} dir="auto">
                    {message}
                  </li>
                ))}
              </ul>
            </>
          )}
        </Alert>
      )}
      {panel === 'status' && <StatusPanel ids={ids} names={names} onDone={closePanel} />}
      {panel === 'tags' && <ProductTagsPanel ids={ids} names={names} onDone={closePanel} />}
      {panel === 'collection' && <CollectionPanel ids={ids} names={names} onDone={closePanel} />}
      {panel === 'delete' && <DeletePanel ids={ids} names={names} onDone={closePanel} />}
      {products.isPending ? (
        <Loading label={t('state.loading')} />
      ) : products.isError ? (
        <ErrorState
          message={errorText(products.error, t)}
          action={<Button onClick={() => void products.refetch()}>{t('action.retry')}</Button>}
        />
      ) : shown.length === 0 ? (
        <Card>
          <EmptyState
            icon={<PackageOpen aria-hidden className="size-8 text-secondary" />}
            title={q || status ? t('products.noneFound') : t('products.none')}
            body={
              q || status ? undefined : t(edits ? 'products.noneBody' : 'products.noneBodyView')
            }
          />
        </Card>
      ) : (
        <Card>
          {edits && (
            <div className="flex items-center gap-3 border-b border-line px-4 py-2">
              <input
                type="checkbox"
                checked={selected.size === shown.length}
                onChange={(event) =>
                  setSelected(
                    event.target.checked ? new Set(shown.map((product) => product.id)) : new Set(),
                  )
                }
                aria-label={t('orders.selectAll')}
                className="size-5 accent-[var(--hatti-color-primary)]"
              />
              <span className="text-secondary">
                {t('orders.selected', { count: formatCount(selected.size) })}
              </span>
            </div>
          )}
          <ul className="divide-y divide-line">
            {shown.map((product) => (
              <ProductRow
                key={product.id}
                product={product}
                selectable={edits}
                selected={selected.has(product.id)}
                onSelect={(on) =>
                  setSelected((current) => {
                    const next = new Set(current);
                    if (on) next.add(product.id);
                    else next.delete(product.id);
                    return next;
                  })
                }
              />
            ))}
          </ul>
          {products.hasNextPage && (
            <div className="border-t border-line p-3 text-center">
              <Button
                variant="tertiary"
                busy={products.isFetchingNextPage}
                onClick={() => void products.fetchNextPage()}
              >
                {t('orders.more')}
              </Button>
            </div>
          )}
        </Card>
      )}
      {edits && selected.size > 0 && !panel && (
        <div className="fixed inset-x-0 bottom-16 z-20 flex flex-wrap justify-center gap-2 px-4 md:bottom-6">
          <Button
            icon={<ToggleRight aria-hidden className="size-5" />}
            onClick={() => open('status')}
          >
            {t('productBulk.status.button', { count: formatCount(selected.size) })}
          </Button>
          <Button
            variant="secondary"
            icon={<Tags aria-hidden className="size-5" />}
            onClick={() => open('tags')}
          >
            {t('bulk.tag', { count: formatCount(selected.size) })}
          </Button>
          <Button
            variant="secondary"
            icon={<FolderPlus aria-hidden className="size-5" />}
            onClick={() => open('collection')}
          >
            {t('productBulk.collection.button', { count: formatCount(selected.size) })}
          </Button>
          <Button
            variant="secondary"
            icon={<Trash2 aria-hidden className="size-5" />}
            onClick={() => open('delete')}
          >
            {t('productBulk.delete.button', { count: formatCount(selected.size) })}
          </Button>
        </div>
      )}
    </div>
  );
}
