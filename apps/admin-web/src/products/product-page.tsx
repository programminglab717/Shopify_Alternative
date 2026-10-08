import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { ArrowLeft, Save, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import {
  InventorySetQuantitiesMutation,
  ProductDeleteMutation,
  ProductQuery,
  ProductUpdateMutation,
  ProductVariantsBulkUpdateMutation,
} from '../api/operations';
import type {
  InventorySetQuantitiesData,
  LocationRef,
  ProductData,
  ProductDeleteData,
  ProductDetail,
  ProductUpdateData,
  ProductVariantDetail,
  ProductVariantsBulkUpdateData,
  UserError,
} from '../api/types';
import { errorText } from '../i18n/errors';
import { formatCount } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import { useAdminMutation, useAdminQuery, useShop } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, EmptyState, ErrorState, Loading } from '../ui/feedback';
import {
  CellInput,
  DetailsFields,
  detailsInput,
  FormSection,
  OrganiseFields,
  parsePrice,
  parseStock,
  priceText,
  problemText,
  StatusChoice,
} from './product-form';
import type { DetailsState } from './product-form';
import { ProductPhotos } from './photos';
import { EDITS_PRODUCTS, ProductStatusBadge, ProductThumb } from './status';

/** A product's page's search: whether it was just added, and its stock with it. */
export interface ProductSearch {
  added?: 'ok' | 'noStock';
}

export function validateProductSearch(search: Record<string, unknown>): ProductSearch {
  return search.added === 'ok' || search.added === 'noStock' ? { added: search.added } : {};
}

/** A variant's row as the form holds it, with what was read to tell what changed. */
interface VariantRow {
  variant: ProductVariantDetail;
  price: string;
  compareAtPrice: string;
  sku: string;
  /** Available at the location, as typed; blank while it is not tracked. */
  stock: string;
  /** Available at the location when read, or null where it is not tracked there. */
  stockWas: number | null;
}

function rowsOf(product: ProductDetail, location: LocationRef | null): VariantRow[] {
  return product.variants.map((variant) => {
    const level = variant.inventoryItem.inventoryLevels.find(
      (each) => each.location.id === location?.id,
    );
    const stockWas = variant.inventoryItem.tracked && level ? level.available : null;
    return {
      variant,
      price: priceText(variant.price.amount),
      compareAtPrice: priceText(variant.compareAtPrice?.amount),
      sku: variant.sku ?? '',
      stock: stockWas === null ? '' : String(stockWas),
      stockWas,
    };
  });
}

/** Whether the product is sold as it is, its one variant Shopify's "Default Title". */
function single(product: ProductDetail): boolean {
  return (
    product.variants.length === 1 &&
    product.options.length <= 1 &&
    (product.options[0]?.optionValues.length ?? 1) <= 1 &&
    product.variants[0]!.title === 'Default Title'
  );
}

/** The variants' prices, SKUs and stock: one set of fields, or a row for each variant. */
function VariantFields({
  product,
  rows,
  location,
  onChange,
  showInvalid,
}: {
  product: ProductDetail;
  rows: VariantRow[];
  location: LocationRef | null;
  onChange: (rows: VariantRow[]) => void;
  showInvalid: boolean;
}) {
  const { t } = useLocale();
  const set = (index: number, change: Partial<VariantRow>) =>
    onChange(rows.map((row, at) => (at === index ? { ...row, ...change } : row)));
  const stockHint = location ? t('product.stockAt', { location: location.name }) : undefined;

  if (single(product)) {
    const row = rows[0]!;
    return (
      <FormSection title={t('product.priceAndStock')} hint={stockHint}>
        <div className="grid grid-cols-2 gap-3">
          <label className="flex min-w-0 flex-col gap-1">
            <span className="font-medium">{t('product.price')}</span>
            <CellInput
              label={t('product.price')}
              numeric
              value={row.price}
              invalid={showInvalid && parsePrice(row.price) === null}
              onChange={(price) => set(0, { price })}
            />
          </label>
          <label className="flex min-w-0 flex-col gap-1">
            <span className="font-medium">{t('product.compareAt')}</span>
            <CellInput
              label={t('product.compareAt')}
              numeric
              value={row.compareAtPrice}
              invalid={
                showInvalid &&
                row.compareAtPrice.trim() !== '' &&
                parsePrice(row.compareAtPrice) === null
              }
              onChange={(compareAtPrice) => set(0, { compareAtPrice })}
            />
          </label>
          <label className="flex min-w-0 flex-col gap-1">
            <span className="font-medium">{t('product.stock')}</span>
            <CellInput
              label={t('product.stock')}
              numeric
              value={row.stock}
              placeholder={row.stockWas === null ? t('product.notTracked') : undefined}
              invalid={showInvalid && row.stock.trim() !== '' && parseStock(row.stock) === null}
              onChange={(stock) => set(0, { stock })}
            />
          </label>
          <label className="flex min-w-0 flex-col gap-1">
            <span className="font-medium">{t('product.sku')}</span>
            <CellInput
              label={t('product.sku')}
              value={row.sku}
              onChange={(sku) => set(0, { sku })}
            />
          </label>
        </div>
      </FormSection>
    );
  }

  return (
    <FormSection
      title={t('product.variants', { count: formatCount(rows.length) })}
      hint={stockHint}
    >
      <ul className="flex flex-col divide-y divide-line">
        {rows.map((row, index) => {
          const name = row.variant.title;
          return (
            <li key={row.variant.id} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
              <span className="font-medium" dir="auto">
                {name}
              </span>
              <div className="grid grid-cols-3 gap-2">
                <CellInput
                  label={t('product.priceOf', { variant: name })}
                  placeholder={t('product.price')}
                  numeric
                  value={row.price}
                  invalid={showInvalid && parsePrice(row.price) === null}
                  onChange={(price) => set(index, { price })}
                />
                <CellInput
                  label={t('product.stockOf', { variant: name })}
                  placeholder={row.stockWas === null ? t('product.notTracked') : t('product.stock')}
                  numeric
                  value={row.stock}
                  invalid={showInvalid && row.stock.trim() !== '' && parseStock(row.stock) === null}
                  onChange={(stock) => set(index, { stock })}
                />
                <CellInput
                  label={t('product.skuOf', { variant: name })}
                  placeholder={t('product.sku')}
                  value={row.sku}
                  onChange={(sku) => set(index, { sku })}
                />
              </div>
            </li>
          );
        })}
      </ul>
    </FormSection>
  );
}

/** The form for a product as read: what changed is saved, the rest left as it is. */
function ProductEditor({
  product,
  location,
  edits,
  onSaved,
}: {
  product: ProductDetail;
  location: LocationRef | null;
  edits: boolean;
  onSaved: () => void;
}) {
  const { t } = useLocale();
  const navigate = useNavigate();
  const shopId = useShop().id;
  const read: DetailsState = {
    title: product.title,
    description: product.description,
    status: product.status,
    productType: product.productType ?? '',
    vendor: product.vendor ?? '',
    tags: product.tags.join(', '),
  };
  const [details, setDetails] = useState(read);
  const [rows, setRows] = useState(() => rowsOf(product, location));
  const [problems, setProblems] = useState<string[]>([]);
  const [showInvalid, setShowInvalid] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const update = useAdminMutation<ProductUpdateData, { input: Record<string, unknown> }>(
    ProductUpdateMutation,
  );
  const variants = useAdminMutation<
    ProductVariantsBulkUpdateData,
    { productId: string; variants: Record<string, unknown>[] }
  >(ProductVariantsBulkUpdateMutation);
  const stock = useAdminMutation<InventorySetQuantitiesData, { input: Record<string, unknown> }>(
    InventorySetQuantitiesMutation,
  );
  const remove = useAdminMutation<ProductDeleteData, { input: { id: string } }>(
    ProductDeleteMutation,
  );
  const busy = update.isPending || variants.isPending || stock.isPending;

  const detailsChanged =
    JSON.stringify(detailsInput(details)) !== JSON.stringify(detailsInput(read));
  const variantChanges = rows.filter(
    (row) =>
      parsePrice(row.price) !== parsePrice(priceText(row.variant.price.amount)) ||
      (parsePrice(row.compareAtPrice) ?? '') !==
        (parsePrice(priceText(row.variant.compareAtPrice?.amount)) ?? '') ||
      row.sku.trim() !== (row.variant.sku ?? ''),
  );
  const stockChanges = rows.filter(
    (row) => row.stock.trim() !== '' && parseStock(row.stock) !== row.stockWas,
  );
  const changed = detailsChanged || variantChanges.length > 0 || stockChanges.length > 0;

  const onSave = async (event: FormEvent) => {
    event.preventDefault();
    setProblems([]);
    const invalid =
      !details.title.trim() ||
      rows.some(
        (row) =>
          parsePrice(row.price) === null ||
          (row.compareAtPrice.trim() !== '' && parsePrice(row.compareAtPrice) === null) ||
          (row.stock.trim() !== '' && parseStock(row.stock) === null),
      );
    if (invalid) {
      setShowInvalid(true);
      setProblems([t('product.fixFields')]);
      return;
    }
    const failed = (errors: UserError[]) => {
      if (errors.length === 0) return false;
      setProblems(errors.map((error) => problemText(error, t)));
      return true;
    };
    try {
      if (detailsChanged) {
        const { productUpdate } = await update.mutateAsync({
          input: { id: product.id, ...detailsInput(details) },
        });
        if (failed(productUpdate.userErrors)) return;
      }
      if (variantChanges.length > 0) {
        const { productVariantsBulkUpdate } = await variants.mutateAsync({
          productId: product.id,
          variants: variantChanges.map((row) => ({
            id: row.variant.id,
            price: parsePrice(row.price),
            compareAtPrice: parsePrice(row.compareAtPrice),
            sku: row.sku.trim() || null,
          })),
        });
        if (failed(productVariantsBulkUpdate.userErrors)) return;
      }
      if (stockChanges.length > 0 && location) {
        const { inventorySetQuantities } = await stock.mutateAsync({
          input: {
            name: 'available',
            reason: 'correction',
            quantities: stockChanges.map((row) => ({
              inventoryItemId: row.variant.inventoryItem.id,
              locationId: location.id,
              quantity: parseStock(row.stock),
              ...(row.stockWas !== null && { compareQuantity: row.stockWas }),
            })),
          },
        });
        if (failed(inventorySetQuantities.userErrors)) return;
      }
      onSaved();
    } catch (failure) {
      setProblems([errorText(failure, t)]);
    }
  };

  const onDelete = async () => {
    try {
      const { productDelete } = await remove.mutateAsync({ input: { id: product.id } });
      if (productDelete.userErrors.length > 0) {
        setProblems(productDelete.userErrors.map((error) => problemText(error, t)));
        return;
      }
      void navigate({ to: '/$shopId/products', params: { shopId }, replace: true });
    } catch (failure) {
      setProblems([errorText(failure, t)]);
    }
  };

  return (
    <form onSubmit={(event) => void onSave(event)} className="flex flex-col gap-4">
      <fieldset disabled={!edits} className="contents">
        <div className="grid gap-4 md:grid-cols-[2fr_1fr] md:items-start">
          <div className="flex flex-col gap-4">
            <DetailsFields details={details} onChange={setDetails} />
            <VariantFields
              product={product}
              rows={rows}
              location={location}
              onChange={setRows}
              showInvalid={showInvalid}
            />
          </div>
          <div className="flex flex-col gap-4">
            <StatusChoice
              status={details.status}
              onChange={(status) => setDetails({ ...details, status })}
            />
            <OrganiseFields details={details} onChange={setDetails} />
          </div>
        </div>
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
      {edits && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          {deleting ? (
            <div className="flex flex-wrap items-center gap-2">
              <span>{t('product.deleteSure')}</span>
              <Button variant="destructive" busy={remove.isPending} onClick={() => void onDelete()}>
                {t('product.deleteYes')}
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
              {t('product.delete')}
            </Button>
          )}
          <Button
            type="submit"
            busy={busy}
            disabled={!changed}
            icon={<Save aria-hidden className="size-5" />}
          >
            {t('product.save')}
          </Button>
        </div>
      )}
    </form>
  );
}

/**
 * A product's page (CAT-01): its details, price, stock and status, which owners and managers
 * change and everyone else reads.
 */
export function ProductPage() {
  const { t } = useLocale();
  const shop = useShop();
  const { productId } = useParams({ from: '/$shopId/products/$productId' });
  const { added } = useSearch({ from: '/$shopId/products/$productId' });
  const query = useAdminQuery<ProductData>(
    ['product', productId],
    ProductQuery,
    { id: productId },
    // Read again while photos are being made ready, to show each once it is.
    {
      refetchInterval: (data) =>
        data?.product?.media.some(
          (each) => each.status === 'UPLOADED' || each.status === 'PROCESSING',
        )
          ? 2000
          : false,
    },
  );
  const [saved, setSaved] = useState(0);

  const back = (
    <Link
      to="/$shopId/products"
      params={{ shopId: shop.id }}
      className="inline-flex min-h-10 items-center gap-1 self-start text-secondary hover:text-text"
    >
      <ArrowLeft aria-hidden className="size-5 rtl:rotate-180" />
      {t('products.title')}
    </Link>
  );

  if (query.isPending) return <Loading label={t('state.loading')} />;
  if (query.isError) {
    return (
      <ErrorState
        message={errorText(query.error, t)}
        action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
      />
    );
  }
  const { product, location } = query.data;
  const edits = EDITS_PRODUCTS.includes(shop.role);
  if (!product) {
    return (
      <div className="mx-auto flex max-w-5xl flex-col gap-4">
        {back}
        <EmptyState title={t('product.notFound')} />
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4 pb-8">
      {back}
      <header className="flex items-center gap-3">
        <ProductThumb media={product.media} size="lg" />
        <div className="flex min-w-0 flex-col items-start gap-1">
          <h1
            className="max-w-full truncate text-[length:var(--hatti-type-title-size)] font-semibold"
            dir="auto"
          >
            {product.title}
          </h1>
          <ProductStatusBadge status={product.status} />
        </div>
      </header>
      {saved > 0 ? (
        <Alert tone="success">{t('product.saved')}</Alert>
      ) : added === 'ok' ? (
        <Alert tone="success">{t('product.added')}</Alert>
      ) : added === 'noStock' ? (
        <Alert tone="warning">{t('product.addedNoStock')}</Alert>
      ) : null}
      <ProductPhotos product={product} edits={edits} />
      {/* Filled in afresh after each save, from the product read again; not as photos change. */}
      <ProductEditor
        key={saved}
        product={product}
        location={location}
        edits={edits}
        onSaved={() => setSaved((count) => count + 1)}
      />
    </div>
  );
}
