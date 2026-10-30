import { Copy, Globe, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import {
  CollectionsQuery,
  ExpansionStoreAutoCopySetMutation,
  ExpansionStoreCollectionMarginsSetMutation,
  ExpansionStoreGroupMarginsSetMutation,
  ExpansionStoreProductMarginsSetMutation,
  ExpansionStoreCopyMutation,
  ExpansionStoreFollowRateSetMutation,
  ExpansionStorePricingSetMutation,
  ExpansionStoreRemoveMutation,
  ExpansionStoreSalesQuery,
  ExpansionStoreSaveMutation,
  ExpansionStoresQuery,
  ProductsQuery,
} from '../api/operations';
import type {
  CollectionsData,
  ExpansionGroupMargin,
  ExpansionStore,
  ExpansionStorePayloadData,
  ExpansionStoreSalesData,
  ExpansionStoresData,
  PresentmentRounding,
  ProductsData,
} from '../api/types';
import { useRecentAuthentication } from '../auth/confirm-identity';
import { useMe } from '../auth/context';
import { errorText } from '../i18n/errors';
import { StackedBars } from '../analytics/figures';
import { startOfDay } from '../analytics/period';
import { formatDate, formatDateTime, formatMoney } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import { problemText } from '../products/product-form';
import {
  useAdminMutation,
  useAdminQuery,
  useShop,
  useShopDetails,
  useShopTimezone,
} from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, Card, ErrorState, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';
import { BackToSettings } from './settings-page';
import { CheckField, SelectField } from './settings-form';

/**
 * Expansion stores (CH-11, ADR-859): other shops of the owner's, an international store say,
 * whose products are copied from this one at a price rate, and copied again to update them, as
 * Shopify Plus keeps its expansion stores in step. The owner alone keeps them, of both shops.
 */
export function ExpansionStoresPage() {
  const { t, locale } = useLocale();
  const shop = useShop();
  const timezone = useShopTimezone();
  const from = useShopDetails()?.currencyCode ?? 'PKR';
  const me = useMe();
  const query = useAdminQuery<ExpansionStoresData>(['expansionStores'], ExpansionStoresQuery);
  const save = useAdminMutation<ExpansionStorePayloadData, { shopId: string; priceRate: string }>(
    ExpansionStoreSaveMutation,
  );
  const copy = useAdminMutation<ExpansionStorePayloadData, { shopId: string }>(
    ExpansionStoreCopyMutation,
  );
  const remove = useAdminMutation<ExpansionStorePayloadData, { shopId: string }>(
    ExpansionStoreRemoveMutation,
  );
  const auto = useAdminMutation<ExpansionStorePayloadData, { shopId: string; enabled: boolean }>(
    ExpansionStoreAutoCopySetMutation,
  );
  const follow = useAdminMutation<ExpansionStorePayloadData, { shopId: string; enabled: boolean }>(
    ExpansionStoreFollowRateSetMutation,
  );
  const pricing = useAdminMutation<
    ExpansionStorePayloadData,
    { shopId: string; marginPercent: number; rounding: PresentmentRounding }
  >(ExpansionStorePricingSetMutation);
  const marginsSet = useAdminMutation<
    ExpansionStorePayloadData,
    { shopId: string; margins: { collectionId: string; marginPercent: number }[] }
  >(ExpansionStoreCollectionMarginsSetMutation);
  const productMarginsSet = useAdminMutation<
    ExpansionStorePayloadData,
    { shopId: string; margins: { productId: string; marginPercent: number }[] }
  >(ExpansionStoreProductMarginsSetMutation);
  const groupMarginsSet = useAdminMutation<
    ExpansionStorePayloadData,
    { shopId: string; margins: ExpansionGroupMargin[] }
  >(ExpansionStoreGroupMarginsSetMutation);
  const recent = useRecentAuthentication();
  const [chosen, setChosen] = useState('');
  const [rate, setRate] = useState('1');
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const linked = new Set((query.data?.expansionStores ?? []).map((each) => each.shopId));
  const others = (me.data?.shops ?? []).filter(
    (each) => each.role === 'owner' && each.id !== shop.id && !linked.has(each.id),
  );
  const target = chosen || others[0]?.id || '';
  const onError = (failure: unknown) => setProblem(errorText(failure, t));

  const onAdd = async (event: FormEvent) => {
    event.preventDefault();
    setProblem(null);
    setBusy('add');
    await recent.run(async () => {
      const done = (await save.mutateAsync({ shopId: target, priceRate: rate.trim() }))
        .expansionStoreSave!;
      if (done.userErrors[0]) setProblem(problemText(done.userErrors[0], t));
      else setChosen('');
    }, onError);
    setBusy(null);
  };

  const onCopy = async (shopId: string) => {
    setProblem(null);
    setBusy(shopId);
    await recent.run(async () => {
      const done = (await copy.mutateAsync({ shopId })).expansionStoreCopy!;
      if (done.userErrors[0]) setProblem(problemText(done.userErrors[0], t));
    }, onError);
    setBusy(null);
  };

  const onAuto = async (shopId: string, enabled: boolean) => {
    setProblem(null);
    await recent.run(async () => {
      const done = (await auto.mutateAsync({ shopId, enabled })).expansionStoreAutoCopySet!;
      if (done.userErrors[0]) setProblem(problemText(done.userErrors[0], t));
    }, onError);
  };

  const onFollow = async (shopId: string, enabled: boolean) => {
    setProblem(null);
    await recent.run(async () => {
      const done = (await follow.mutateAsync({ shopId, enabled })).expansionStoreFollowRateSet!;
      if (done.userErrors[0]) setProblem(problemText(done.userErrors[0], t));
    }, onError);
  };

  const onPricing = async (
    shopId: string,
    marginPercent: number,
    rounding: PresentmentRounding,
  ) => {
    setProblem(null);
    setBusy(`pricing-${shopId}`);
    await recent.run(async () => {
      const done = (await pricing.mutateAsync({ shopId, marginPercent, rounding }))
        .expansionStorePricingSet!;
      if (done.userErrors[0]) setProblem(problemText(done.userErrors[0], t));
    }, onError);
    setBusy(null);
  };

  const onMargins = async (
    shopId: string,
    margins: { collectionId: string; marginPercent: number }[],
  ) => {
    setProblem(null);
    setBusy(`margins-${shopId}`);
    await recent.run(async () => {
      const done = (await marginsSet.mutateAsync({ shopId, margins }))
        .expansionStoreCollectionMarginsSet!;
      if (done.userErrors[0]) setProblem(problemText(done.userErrors[0], t));
    }, onError);
    setBusy(null);
  };

  const onProductMargins = async (
    shopId: string,
    margins: { productId: string; marginPercent: number }[],
  ) => {
    setProblem(null);
    setBusy(`product-margins-${shopId}`);
    await recent.run(async () => {
      const done = (await productMarginsSet.mutateAsync({ shopId, margins }))
        .expansionStoreProductMarginsSet!;
      if (done.userErrors[0]) setProblem(problemText(done.userErrors[0], t));
    }, onError);
    setBusy(null);
  };

  const onGroupMargins = async (shopId: string, margins: ExpansionGroupMargin[]) => {
    setProblem(null);
    setBusy(`group-margins-${shopId}`);
    await recent.run(async () => {
      const done = (await groupMarginsSet.mutateAsync({ shopId, margins }))
        .expansionStoreGroupMarginsSet!;
      if (done.userErrors[0]) setProblem(problemText(done.userErrors[0], t));
    }, onError);
    setBusy(null);
  };

  const onRemove = async (shopId: string) => {
    setProblem(null);
    try {
      const done = (await remove.mutateAsync({ shopId })).expansionStoreRemove!;
      if (done.userErrors[0]) setProblem(problemText(done.userErrors[0], t));
    } catch (failure) {
      onError(failure);
    }
  };

  const body = () => {
    if (query.isPending) return <Loading label={t('state.loading')} />;
    if (query.isError) {
      return (
        <ErrorState
          message={errorText(query.error, t)}
          action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
        />
      );
    }
    const stores = query.data.expansionStores;
    return (
      <>
        {stores.length === 0 ? (
          <p className="text-secondary">{t('expansion.none')}</p>
        ) : (
          <Card>
            <ul className="divide-y divide-line">
              {stores.map((store) => (
                <li key={store.shopId} className="flex flex-col gap-2 px-4 py-3">
                  <span className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="font-medium" dir="auto">
                      {store.name}
                    </span>
                    <span className="num text-secondary">
                      {t('expansion.rateOf', {
                        currency: store.currencyCode,
                        rate: store.priceRate,
                        from,
                      })}
                    </span>
                  </span>
                  <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
                    {store.copiedAt && store.lastCopy
                      ? t('expansion.copied', {
                          date: formatDateTime(store.copiedAt, timezone, locale),
                          created: store.lastCopy.created,
                          updated: store.lastCopy.updated,
                          problems: store.lastCopy.problems,
                        })
                      : t('expansion.never')}
                  </span>
                  <CheckField
                    label={t('expansion.follow', { currency: store.currencyCode, from })}
                    checked={store.followRate}
                    onChange={(enabled) =>
                      !follow.isPending && void onFollow(store.shopId, enabled)
                    }
                  />
                  <Pricing
                    store={store}
                    busy={busy === `pricing-${store.shopId}`}
                    onSave={(margin, rounding) => void onPricing(store.shopId, margin, rounding)}
                  />
                  <CollectionMargins
                    store={store}
                    busy={busy === `margins-${store.shopId}`}
                    onSave={(margins) => void onMargins(store.shopId, margins)}
                  />
                  <ProductMargins
                    store={store}
                    busy={busy === `product-margins-${store.shopId}`}
                    onSave={(margins) => void onProductMargins(store.shopId, margins)}
                  />
                  <GroupMargins
                    store={store}
                    busy={busy === `group-margins-${store.shopId}`}
                    onSave={(margins) => void onGroupMargins(store.shopId, margins)}
                  />
                  <CheckField
                    label={t('expansion.auto', { name: store.name })}
                    checked={store.autoCopy}
                    onChange={(enabled) => !auto.isPending && void onAuto(store.shopId, enabled)}
                  />
                  {store.autoCopy && store.copyError && store.copyFailedAt && (
                    <Alert tone="danger">
                      {t('expansion.failed', {
                        date: formatDateTime(store.copyFailedAt, timezone, locale),
                        error: store.copyError,
                      })}
                    </Alert>
                  )}
                  <span className="flex flex-wrap gap-2">
                    <Button
                      variant="secondary"
                      icon={<Copy aria-hidden className="size-5" />}
                      busy={busy === store.shopId}
                      onClick={() => void onCopy(store.shopId)}
                    >
                      {t('expansion.copy', { name: store.name })}
                    </Button>
                    <Button
                      variant="danger"
                      icon={<Trash2 aria-hidden className="size-5" />}
                      aria-label={t('expansion.remove', { name: store.name })}
                      onClick={() => void onRemove(store.shopId)}
                    />
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        )}
        {others.length === 0 ? (
          stores.length === 0 && <p className="text-secondary">{t('expansion.noOther')}</p>
        ) : (
          <Card className="p-4">
            <form onSubmit={(event) => void onAdd(event)} className="flex flex-col gap-3">
              <SelectField
                label={t('expansion.shop')}
                value={target}
                options={others.map((each) => ({ value: each.id, label: each.name }))}
                onChange={setChosen}
              />
              <TextField
                label={t('expansion.rate')}
                hint={t('expansion.rateHint')}
                inputMode="decimal"
                dir="ltr"
                value={rate}
                onChange={(event) => setRate(event.target.value)}
                required
              />
              <Button type="submit" className="self-start" busy={busy === 'add'}>
                {t('expansion.add')}
              </Button>
            </form>
          </Card>
        )}
      </>
    );
  };

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 pb-8">
      <BackToSettings />
      <h1 className="flex items-center gap-2 text-[length:var(--hatti-type-display-size)] font-semibold">
        <Globe aria-hidden className="size-7 text-secondary" />
        {t('settings.expansion')}
      </h1>
      <p className="text-secondary">{t('expansion.hint')}</p>
      {problem && <Alert tone="danger">{problem}</Alert>}
      {body()}
      {(query.data?.expansionStores.length ?? 0) > 0 && <StoreSales />}
      {recent.panel}
    </div>
  );
}

const PERIODS = [7, 30, 90] as const;

/**
 * What this shop and each of its expansion stores sold lately, on one page (ADR-932): each in its
 * own currency and in this shop's at the day's rate, and all of them together; and day by day, or
 * week by week over 90 days, each store's part of each bar in rupees (ADR-955). In the sales
 * report (ADR-979), the report's own period is given, and no other is offered.
 */
export function StoreSales({ period: given }: { period?: (typeof PERIODS)[number] } = {}) {
  const { t, locale } = useLocale();
  const timezone = useShopTimezone();
  const [chosen, setDays] = useState<(typeof PERIODS)[number]>(30);
  const days = given ?? chosen;
  // Whole days in the shop's time, today's included, as the page was opened: the same period
  // however often it is drawn, its days the chart's.
  const [now] = useState(() => new Date());
  const weeks = days > 30;
  const period = useMemo(
    () => ({
      from: startOfDay(timezone, days - 1, now).toISOString(),
      before: startOfDay(timezone, -1, now).toISOString(),
      interval: weeks ? 'WEEK' : 'DAY',
    }),
    [now, days, timezone, weeks],
  );
  const query = useAdminQuery<ExpansionStoreSalesData>(
    ['expansionStoreSales', days],
    ExpansionStoreSalesQuery,
    period,
  );
  const rows = query.data?.expansionStoreSales ?? [];
  const here = rows.find((row) => row.here)?.currencyCode ?? 'PKR';
  const total = rows.reduce((sum, row) => sum + Number(row.totalSalesHere?.amount ?? 0), 0);
  const unconverted = rows.some((row) => row.totalSalesHere === null);
  // The stores with a day's rate, each a part of each bar.
  const charted = rows.filter((row) => row.totalSalesHere !== null);
  const stacks = (charted[0]?.periods ?? []).map((each, index) => {
    const parts = charted.map((row) => Number(row.periods[index]?.totalSalesHere?.amount ?? 0));
    const sum = parts.reduce((total, part) => total + part, 0);
    return {
      start: each.start,
      parts,
      label: t('expansion.salesBar', {
        date: formatDate(each.start, timezone, locale),
        amount: formatMoney(sum.toFixed(2), here),
      }),
    };
  });
  return (
    <section aria-labelledby="expansion-sales" className="flex flex-col gap-2">
      <h2 id="expansion-sales" className="font-semibold">
        {t('expansion.sales')}
      </h2>
      <Card className="flex flex-col gap-3 p-4">
        {given === undefined && (
          <SelectField
            label={t('expansion.salesPeriod')}
            value={String(days)}
            options={PERIODS.map((each) => ({
              value: String(each),
              label: t('expansion.days', { count: each }),
            }))}
            onChange={(value) => setDays(Number(value) as (typeof PERIODS)[number])}
          />
        )}
        {query.isPending ? (
          <Loading label={t('state.loading')} />
        ) : query.isError ? (
          <Alert tone="danger">{errorText(query.error, t)}</Alert>
        ) : (
          <>
            <ul className="divide-y divide-line">
              {rows.map((row) => (
                <li key={row.shopId} className="flex flex-wrap justify-between gap-2 py-2">
                  <span className="font-medium" dir="auto">
                    {row.here ? t('expansion.thisShop', { name: row.name }) : row.name}
                  </span>
                  <span className="num flex flex-col items-end text-secondary">
                    <span>
                      {t('expansion.salesLine', {
                        orders: row.orders,
                        amount: formatMoney(row.totalSales.amount, row.totalSales.currencyCode),
                      })}
                    </span>
                    {!row.here && row.totalSalesHere && (
                      <span className="text-[length:var(--hatti-type-body-sm-size)]">
                        {t('expansion.salesHere', {
                          amount: formatMoney(
                            row.totalSalesHere.amount,
                            row.totalSalesHere.currencyCode,
                          ),
                        })}
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
            <p className="num font-semibold">
              {t('expansion.salesTotal', { amount: formatMoney(total.toFixed(2), here) })}
            </p>
            <StackedBars
              title={t(weeks ? 'expansion.salesChartWeeks' : 'expansion.salesChart')}
              series={charted.map((row) =>
                row.here ? t('expansion.thisShop', { name: row.name }) : row.name,
              )}
              stacks={stacks}
            />
            {unconverted && <p className="text-secondary">{t('expansion.salesUnconverted')}</p>}
          </>
        )}
      </Card>
    </section>
  );
}

/**
 * An expansion store's copied prices a percent over its rate, and rounded as its prices abroad
 * are (ADR-933).
 */
function Pricing({
  store,
  busy,
  onSave,
}: {
  store: ExpansionStore;
  busy: boolean;
  onSave: (marginPercent: number, rounding: PresentmentRounding) => void;
}) {
  const { t } = useLocale();
  const [margin, setMargin] = useState(String(store.marginPercent));
  const [rounding, setRounding] = useState<PresentmentRounding>(store.rounding);
  return (
    <div className="grid grid-cols-1 items-end gap-2 sm:grid-cols-[1fr_1fr_auto]">
      <TextField
        label={t('expansion.margin')}
        hint={t('expansion.marginHint')}
        inputMode="numeric"
        dir="ltr"
        value={margin}
        onChange={(event) => setMargin(event.target.value)}
      />
      <SelectField
        label={t('currencies.rounding')}
        value={rounding}
        options={[
          { value: 'exact', label: t('currencies.roundExact') },
          { value: 'whole', label: t('currencies.roundWhole') },
          { value: 'ninety_nine', label: t('currencies.roundNinetyNine') },
        ]}
        onChange={setRounding}
      />
      <Button
        variant="secondary"
        busy={busy}
        aria-label={t('expansion.savePricing', { name: store.name })}
        onClick={() => onSave(Number(margin.trim() || '0'), rounding)}
      >
        {t('expansion.save')}
      </Button>
    </div>
  );
}

/**
 * The store's collections with a margin of their own over its rate (ADR-948), the first of a
 * product's giving it: each to change or take out, another to add, saved together.
 */
/**
 * Products of the shop's with a margin of their own over an expansion store's rate (ADR-960),
 * before their collections': found by a search, twenty-five at most.
 */
function ProductMargins({
  store,
  busy,
  onSave,
}: {
  store: ExpansionStore;
  busy: boolean;
  onSave: (margins: { productId: string; marginPercent: number }[]) => void;
}) {
  const { t } = useLocale();
  const [rows, setRows] = useState(
    store.productMargins.map((each) => ({
      productId: each.productId,
      title: each.productTitle,
      margin: String(each.marginPercent),
    })),
  );
  const [words, setWords] = useState('');
  const [searched, setSearched] = useState<string | null>(null);
  const found = useAdminQuery<ProductsData>(
    ['expansionProducts', searched],
    ProductsQuery,
    { first: 10, query: searched },
    { enabled: searched !== null },
  );
  const results = (found.data?.products.nodes ?? []).filter(
    (product) => !rows.some((row) => row.productId === product.id),
  );
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-sm font-medium">{t('expansion.productMargins')}</legend>
      <p className="text-sm text-muted">{t('expansion.productMarginsHint')}</p>
      {rows.map((row, at) => (
        <div key={row.productId} className="grid grid-cols-[1fr_auto] items-end gap-2">
          <TextField
            label={t('expansion.productMargin', { title: row.title })}
            inputMode="numeric"
            dir="ltr"
            value={row.margin}
            onChange={(event) =>
              setRows(
                rows.map((each, index) =>
                  index === at ? { ...each, margin: event.target.value } : each,
                ),
              )
            }
          />
          <Button
            variant="secondary"
            aria-label={t('expansion.removeProductMargin', { title: row.title })}
            onClick={() => setRows(rows.filter((_, index) => index !== at))}
          >
            <Trash2 size={16} aria-hidden />
          </Button>
        </div>
      ))}
      {rows.length < 25 && (
        <div role="search" className="flex items-end gap-2">
          <TextField
            label={t('expansion.findProduct')}
            value={words}
            onChange={(event) => setWords(event.target.value)}
          />
          <Button variant="secondary" onClick={() => setSearched(words.trim())}>
            {t('expansion.find')}
          </Button>
        </div>
      )}
      {results.length > 0 && (
        <ul className="flex flex-wrap gap-2">
          {results.map((product) => (
            <li key={product.id}>
              <Button
                variant="secondary"
                onClick={() =>
                  setRows([...rows, { productId: product.id, title: product.title, margin: '0' }])
                }
              >
                {t('expansion.addProductMargin', { title: product.title })}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <Button
        variant="secondary"
        className="self-start"
        busy={busy}
        aria-label={t('expansion.saveProductMargins', { name: store.name })}
        onClick={() =>
          onSave(
            rows.map((row) => ({
              productId: row.productId,
              marginPercent: Number(row.margin.trim() || '0'),
            })),
          )
        }
      >
        {t('expansion.save')}
      </Button>
    </fieldset>
  );
}

/**
 * Margins by product type, vendor (ADR-971), tag (ADR-976) or a metafield's value (ADR-981),
 * after a product's own and its collection's, a type's before a vendor's, a vendor's before a
 * tag's and a tag's before a metafield's: twenty at most.
 */
function GroupMargins({
  store,
  busy,
  onSave,
}: {
  store: ExpansionStore;
  busy: boolean;
  onSave: (margins: ExpansionGroupMargin[]) => void;
}) {
  const { t } = useLocale();
  const [rows, setRows] = useState(
    (store.groupMargins ?? []).map((each) => ({
      by: each.by,
      key: each.key ?? '',
      value: each.value,
      margin: String(each.marginPercent),
    })),
  );
  const change = (at: number, row: Partial<(typeof rows)[number]>) =>
    setRows(rows.map((each, index) => (index === at ? { ...each, ...row } : each)));
  const kinds = (['PRODUCT_TYPE', 'VENDOR', 'TAG', 'METAFIELD'] as const).map((value) => ({
    value,
    label: t(`expansion.groupBy.${value}`),
  }));
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-sm font-medium">{t('expansion.groupMargins')}</legend>
      <p className="text-sm text-muted">{t('expansion.groupMarginsHint')}</p>
      {rows.map((row, at) => (
        <div
          key={at}
          className={
            row.by === 'METAFIELD'
              ? 'grid grid-cols-1 items-end gap-2 sm:grid-cols-[1fr_1fr_1fr_1fr_auto]'
              : 'grid grid-cols-1 items-end gap-2 sm:grid-cols-[1fr_2fr_1fr_auto]'
          }
        >
          <SelectField
            label={t('expansion.groupBy')}
            value={row.by}
            options={kinds}
            onChange={(by) => change(at, { by })}
          />
          {row.by === 'METAFIELD' && (
            <TextField
              label={t('expansion.groupKey')}
              dir="ltr"
              placeholder="custom.fabric"
              value={row.key}
              onChange={(event) => change(at, { key: event.target.value })}
            />
          )}
          <TextField
            label={t('expansion.groupValue')}
            dir="auto"
            value={row.value}
            onChange={(event) => change(at, { value: event.target.value })}
          />
          <TextField
            label={t('expansion.groupMargin')}
            inputMode="numeric"
            dir="ltr"
            value={row.margin}
            onChange={(event) => change(at, { margin: event.target.value })}
          />
          <Button
            variant="secondary"
            aria-label={t('expansion.removeGroupMargin', { value: row.value })}
            onClick={() => setRows(rows.filter((_, index) => index !== at))}
          >
            <Trash2 size={16} aria-hidden />
          </Button>
        </div>
      ))}
      <div className="flex flex-wrap gap-2">
        {rows.length < 20 && (
          <Button
            variant="secondary"
            onClick={() =>
              setRows([...rows, { by: 'PRODUCT_TYPE', key: '', value: '', margin: '0' }])
            }
          >
            {t('expansion.addGroupMargin')}
          </Button>
        )}
        <Button
          variant="secondary"
          busy={busy}
          aria-label={t('expansion.saveGroupMargins', { name: store.name })}
          onClick={() =>
            onSave(
              rows.map((row) => ({
                by: row.by,
                // A metafield's namespace.key, a metafield's alone.
                ...(row.by === 'METAFIELD' ? { key: row.key.trim() } : {}),
                value: row.value.trim(),
                marginPercent: Number(row.margin.trim() || '0'),
              })),
            )
          }
        >
          {t('expansion.save')}
        </Button>
      </div>
    </fieldset>
  );
}

function CollectionMargins({
  store,
  busy,
  onSave,
}: {
  store: ExpansionStore;
  busy: boolean;
  onSave: (margins: { collectionId: string; marginPercent: number }[]) => void;
}) {
  const { t } = useLocale();
  const collections = useAdminQuery<CollectionsData>(['collections', ''], CollectionsQuery, {
    query: null,
  });
  const [rows, setRows] = useState(
    store.collectionMargins.map((each) => ({
      collectionId: each.collectionId,
      margin: String(each.marginPercent),
    })),
  );
  const options = (collections.data?.collections.nodes ?? []).map((each) => ({
    value: each.id,
    label: each.title,
  }));
  const unused = options.filter((option) => !rows.some((row) => row.collectionId === option.value));
  const change = (at: number, row: Partial<(typeof rows)[number]>) =>
    setRows(rows.map((each, index) => (index === at ? { ...each, ...row } : each)));
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-sm font-medium">{t('expansion.collectionMargins')}</legend>
      <p className="text-sm text-muted">{t('expansion.collectionMarginsHint')}</p>
      {rows.map((row, at) => (
        <div
          key={row.collectionId || at}
          className="grid grid-cols-1 items-end gap-2 sm:grid-cols-[2fr_1fr_auto]"
        >
          <SelectField
            label={t('expansion.collection')}
            value={row.collectionId}
            options={[
              ...options.filter(
                (option) =>
                  option.value === row.collectionId ||
                  !rows.some((other) => other.collectionId === option.value),
              ),
            ]}
            onChange={(collectionId) => change(at, { collectionId })}
          />
          <TextField
            label={t('expansion.collectionMargin')}
            inputMode="numeric"
            dir="ltr"
            value={row.margin}
            onChange={(event) => change(at, { margin: event.target.value })}
          />
          <Button
            variant="secondary"
            aria-label={t('expansion.removeCollectionMargin', {
              title: options.find((option) => option.value === row.collectionId)?.label ?? '',
            })}
            onClick={() => setRows(rows.filter((_, index) => index !== at))}
          >
            <Trash2 size={16} aria-hidden />
          </Button>
        </div>
      ))}
      <div className="flex flex-wrap gap-2">
        {unused.length > 0 && rows.length < 10 && (
          <Button
            variant="secondary"
            onClick={() => setRows([...rows, { collectionId: unused[0]!.value, margin: '0' }])}
          >
            {t('expansion.addCollectionMargin')}
          </Button>
        )}
        <Button
          variant="secondary"
          busy={busy}
          aria-label={t('expansion.saveCollectionMargins', { name: store.name })}
          onClick={() =>
            onSave(
              rows.map((row) => ({
                collectionId: row.collectionId,
                marginPercent: Number(row.margin.trim() || '0'),
              })),
            )
          }
        >
          {t('expansion.save')}
        </Button>
      </div>
    </fieldset>
  );
}
