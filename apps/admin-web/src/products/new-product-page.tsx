import { Link, useNavigate } from '@tanstack/react-router';
import { ArrowLeft, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import {
  InventorySetQuantitiesMutation,
  PrimaryLocationQuery,
  ProductCreateMutation,
} from '../api/operations';
import type {
  InventorySetQuantitiesData,
  PrimaryLocationData,
  ProductCreateData,
  UserError,
} from '../api/types';
import { errorText } from '../i18n/errors';
import { formatCount } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import { useAdminMutation, useAdminQuery, useShop } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, EmptyState } from '../ui/feedback';
import {
  CellInput,
  DetailsFields,
  detailsInput,
  EMPTY_DETAILS,
  FormSection,
  OrganiseFields,
  parsePrice,
  parseStock,
  problemText,
  StatusChoice,
} from './product-form';
import type { ProductSearch } from './product-page';
import { EDITS_PRODUCTS } from './status';

/** The catalog's limits (packages/modules/catalog LIMITS). */
const MAX_OPTIONS = 3;
const MAX_VARIANTS = 250;

interface OptionDraft {
  name: string;
  /** Its values as typed, with commas between them. */
  values: string;
}

interface VariantDraft {
  price: string;
  stock: string;
  sku: string;
}

function valuesOf(option: OptionDraft): string[] {
  return [
    ...new Set(
      option.values
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
}

/** Every combination of the options' values, in the order they were typed. */
export function combinations(options: readonly string[][]): string[][] {
  return options.reduce<string[][]>(
    (rows, values) => rows.flatMap((row) => values.map((value) => [...row, value])),
    [[]],
  );
}

/**
 * Adding a product (CAT-01, docs/design/03 F1): its title, description and price, its stock where
 * the shop keeps it; options such as size or colour make a variant of each combination, each with
 * a price and stock of its own. Pictures are added on its page once it is saved.
 */
export function NewProductPage() {
  const { t } = useLocale();
  const shop = useShop();
  const navigate = useNavigate();
  const location = useAdminQuery<PrimaryLocationData>(['primaryLocation'], PrimaryLocationQuery);
  const create = useAdminMutation<ProductCreateData, { input: Record<string, unknown> }>(
    ProductCreateMutation,
  );
  const stock = useAdminMutation<InventorySetQuantitiesData, { input: Record<string, unknown> }>(
    InventorySetQuantitiesMutation,
  );
  const [details, setDetails] = useState(EMPTY_DETAILS);
  const [price, setPrice] = useState('');
  const [compareAt, setCompareAt] = useState('');
  const [sku, setSku] = useState('');
  const [count, setCount] = useState('');
  const [hasOptions, setHasOptions] = useState(false);
  const [options, setOptions] = useState<OptionDraft[]>([{ name: '', values: '' }]);
  /** Each variant's own price, stock and SKU, by its values joined. */
  const [variants, setVariants] = useState<Record<string, VariantDraft>>({});
  const [problems, setProblems] = useState<string[]>([]);
  const [showInvalid, setShowInvalid] = useState(false);

  const named = options
    .map((option) => ({ name: option.name.trim(), values: valuesOf(option) }))
    .filter((option) => option.name && option.values.length > 0);
  const rows = hasOptions && named.length > 0 ? combinations(named.map((each) => each.values)) : [];
  const draftOf = (values: string[]): VariantDraft =>
    variants[values.join(' / ')] ?? { price: '', stock: '', sku: '' };
  /** A variant's price: its own, or the one for all. */
  const priceOf = (values: string[]) => draftOf(values).price.trim() || price;

  if (!EDITS_PRODUCTS.includes(shop.role)) return <EmptyState title={t('product.cannotEdit')} />;

  const setDraft = (values: string[], change: Partial<VariantDraft>) =>
    setVariants((current) => ({
      ...current,
      [values.join(' / ')]: { ...draftOf(values), ...change },
    }));

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setProblems([]);
    const wrong: string[] = [];
    if (!details.title.trim()) wrong.push(t('product.needsTitle'));
    if (hasOptions) {
      if (named.length === 0) wrong.push(t('product.needsOption'));
      if (rows.length > MAX_VARIANTS) wrong.push(t('product.tooManyVariants'));
      if (rows.some((values) => parsePrice(priceOf(values)) === null)) {
        wrong.push(t('product.needsPrices'));
      }
      if (
        rows.some(
          (values) => draftOf(values).stock.trim() && parseStock(draftOf(values).stock) === null,
        )
      ) {
        wrong.push(t('product.badStock'));
      }
    } else {
      if (parsePrice(price) === null) wrong.push(t('product.needsPrice'));
      if (compareAt.trim() && parsePrice(compareAt) === null) wrong.push(t('product.badCompareAt'));
      if (count.trim() && parseStock(count) === null) wrong.push(t('product.badStock'));
    }
    if (wrong.length > 0) {
      setShowInvalid(true);
      setProblems(wrong);
      return;
    }

    const failed = (errors: UserError[]) => {
      if (errors.length === 0) return false;
      setProblems(errors.map((error) => problemText(error, t)));
      return true;
    };
    try {
      const { productCreate } = await create.mutateAsync({
        input: {
          ...detailsInput(details),
          ...(hasOptions
            ? {
                options: named,
                variants: rows.map((values) => ({
                  optionValues: values,
                  price: parsePrice(priceOf(values)),
                  sku: draftOf(values).sku.trim() || null,
                })),
              }
            : {
                variants: [
                  {
                    price: parsePrice(price),
                    compareAtPrice: compareAt.trim() ? parsePrice(compareAt) : null,
                    sku: sku.trim() || null,
                  },
                ],
              }),
        },
      });
      if (failed(productCreate.userErrors) || !productCreate.product) return;
      const product = productCreate.product;

      // Stock where the merchant counted it, at the shop's primary location.
      const counted = product.variants.flatMap((variant) => {
        const typed = hasOptions
          ? draftOf(variant.selectedOptions.map((option) => option.value)).stock
          : count;
        const quantity = typed.trim() ? parseStock(typed) : null;
        return quantity === null ? [] : [{ inventoryItemId: variant.inventoryItem.id, quantity }];
      });
      const locationId = location.data?.location?.id;
      let added: ProductSearch['added'] = 'ok';
      if (counted.length > 0 && !locationId) added = 'noStock';
      else if (counted.length > 0) {
        // The product is saved either way; its page says when its stock was not.
        try {
          const { inventorySetQuantities } = await stock.mutateAsync({
            input: {
              name: 'available',
              reason: 'received',
              quantities: counted.map((each) => ({ ...each, locationId })),
            },
          });
          if (inventorySetQuantities.userErrors.length > 0) added = 'noStock';
        } catch {
          added = 'noStock';
        }
      }
      void navigate({
        to: '/$shopId/products/$productId',
        params: { shopId: shop.id, productId: product.id },
        search: { added },
        replace: true,
      });
    } catch (failure) {
      setProblems([errorText(failure, t)]);
    }
  };

  const stockHint = location.data?.location
    ? t('product.stockAt', { location: location.data.location.name })
    : undefined;

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4 pb-8">
      <Link
        to="/$shopId/products"
        params={{ shopId: shop.id }}
        className="inline-flex min-h-10 items-center gap-1 self-start text-secondary hover:text-text"
      >
        <ArrowLeft aria-hidden className="size-5 rtl:rotate-180" />
        {t('products.title')}
      </Link>
      <h1 className="text-[length:var(--hatti-type-display-size)] font-semibold">
        {t('product.new')}
      </h1>
      <form onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-4">
        <div className="grid gap-4 md:grid-cols-[2fr_1fr] md:items-start">
          <div className="flex flex-col gap-4">
            <DetailsFields details={details} onChange={setDetails} />

            <FormSection title={t('product.optionsTitle')}>
              <label className="flex items-center gap-3">
                <input
                  type="checkbox"
                  checked={hasOptions}
                  onChange={(event) => setHasOptions(event.target.checked)}
                  className="size-5 accent-[var(--hatti-color-primary)]"
                />
                {t('product.hasOptions')}
              </label>
              {hasOptions && (
                <div className="flex flex-col gap-3">
                  {options.map((option, index) => (
                    <div key={index} className="grid grid-cols-[1fr_2fr_auto] items-end gap-2">
                      <label className="flex min-w-0 flex-col gap-1">
                        <span className="font-medium">{t('product.optionName')}</span>
                        <input
                          value={option.name}
                          dir="auto"
                          placeholder={index === 0 ? t('product.optionNameHint') : undefined}
                          onChange={(event) =>
                            setOptions(
                              options.map((each, at) =>
                                at === index ? { ...each, name: event.target.value } : each,
                              ),
                            )
                          }
                          className="min-h-12 min-w-0 rounded-control border border-line bg-surface px-3 md:min-h-10"
                        />
                      </label>
                      <label className="flex min-w-0 flex-col gap-1">
                        <span className="font-medium">{t('product.optionValues')}</span>
                        <input
                          value={option.values}
                          dir="auto"
                          placeholder={index === 0 ? t('product.optionValuesHint') : undefined}
                          onChange={(event) =>
                            setOptions(
                              options.map((each, at) =>
                                at === index ? { ...each, values: event.target.value } : each,
                              ),
                            )
                          }
                          className="min-h-12 min-w-0 rounded-control border border-line bg-surface px-3 md:min-h-10"
                        />
                      </label>
                      <Button
                        variant="tertiary"
                        aria-label={t('product.removeOption')}
                        disabled={options.length === 1}
                        icon={<Trash2 aria-hidden className="size-5" />}
                        onClick={() => setOptions(options.filter((_, at) => at !== index))}
                      />
                    </div>
                  ))}
                  {options.length < MAX_OPTIONS && (
                    <Button
                      variant="tertiary"
                      className="self-start"
                      icon={<Plus aria-hidden className="size-5" />}
                      onClick={() => setOptions([...options, { name: '', values: '' }])}
                    >
                      {t('product.addOption')}
                    </Button>
                  )}
                </div>
              )}
            </FormSection>

            {hasOptions ? (
              <FormSection
                title={t('product.variants', { count: formatCount(rows.length) })}
                hint={stockHint}
              >
                <label className="flex min-w-0 flex-col gap-1">
                  <span className="font-medium">{t('product.priceForAll')}</span>
                  <CellInput
                    label={t('product.priceForAll')}
                    numeric
                    value={price}
                    onChange={setPrice}
                  />
                </label>
                {rows.length === 0 ? (
                  <p className="text-secondary">{t('product.variantsHint')}</p>
                ) : (
                  <ul className="flex flex-col divide-y divide-line">
                    {rows.map((values) => {
                      const name = values.join(' / ');
                      const draft = draftOf(values);
                      return (
                        <li key={name} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
                          <span className="font-medium" dir="auto">
                            {name}
                          </span>
                          <div className="grid grid-cols-3 gap-2">
                            <CellInput
                              label={t('product.priceOf', { variant: name })}
                              placeholder={price || t('product.price')}
                              numeric
                              value={draft.price}
                              invalid={showInvalid && parsePrice(priceOf(values)) === null}
                              onChange={(value) => setDraft(values, { price: value })}
                            />
                            <CellInput
                              label={t('product.stockOf', { variant: name })}
                              placeholder={t('product.stock')}
                              numeric
                              value={draft.stock}
                              invalid={
                                showInvalid &&
                                draft.stock.trim() !== '' &&
                                parseStock(draft.stock) === null
                              }
                              onChange={(value) => setDraft(values, { stock: value })}
                            />
                            <CellInput
                              label={t('product.skuOf', { variant: name })}
                              placeholder={t('product.sku')}
                              value={draft.sku}
                              onChange={(value) => setDraft(values, { sku: value })}
                            />
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </FormSection>
            ) : (
              <FormSection title={t('product.priceAndStock')} hint={stockHint}>
                <div className="grid grid-cols-2 gap-3">
                  <label className="flex min-w-0 flex-col gap-1">
                    <span className="font-medium">{t('product.price')}</span>
                    <CellInput
                      label={t('product.price')}
                      numeric
                      value={price}
                      invalid={showInvalid && parsePrice(price) === null}
                      onChange={setPrice}
                    />
                  </label>
                  <label className="flex min-w-0 flex-col gap-1">
                    <span className="font-medium">{t('product.compareAt')}</span>
                    <CellInput
                      label={t('product.compareAt')}
                      numeric
                      value={compareAt}
                      invalid={
                        showInvalid && compareAt.trim() !== '' && parsePrice(compareAt) === null
                      }
                      onChange={setCompareAt}
                    />
                  </label>
                  <label className="flex min-w-0 flex-col gap-1">
                    <span className="font-medium">{t('product.stock')}</span>
                    <CellInput
                      label={t('product.stock')}
                      numeric
                      value={count}
                      placeholder={t('product.notTracked')}
                      invalid={showInvalid && count.trim() !== '' && parseStock(count) === null}
                      onChange={setCount}
                    />
                  </label>
                  <label className="flex min-w-0 flex-col gap-1">
                    <span className="font-medium">{t('product.sku')}</span>
                    <CellInput label={t('product.sku')} value={sku} onChange={setSku} />
                  </label>
                </div>
              </FormSection>
            )}
          </div>
          <div className="flex flex-col gap-4">
            <StatusChoice
              status={details.status}
              onChange={(status) => setDetails({ ...details, status })}
            />
            <OrganiseFields details={details} onChange={setDetails} />
          </div>
        </div>
        {problems.length > 0 && (
          <Alert tone="danger">
            <ul className="flex flex-col gap-1">
              {problems.map((problem, index) => (
                <li key={index}>{problem}</li>
              ))}
            </ul>
          </Alert>
        )}
        <Button type="submit" busy={create.isPending || stock.isPending} className="self-end">
          {t('product.create')}
        </Button>
      </form>
    </div>
  );
}
