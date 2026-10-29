import { Copy, Globe, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import {
  ExpansionStoreAutoCopySetMutation,
  ExpansionStoreCopyMutation,
  ExpansionStoreFollowRateSetMutation,
  ExpansionStoreRemoveMutation,
  ExpansionStoreSalesQuery,
  ExpansionStoreSaveMutation,
  ExpansionStoresQuery,
} from '../api/operations';
import type {
  ExpansionStorePayloadData,
  ExpansionStoreSalesData,
  ExpansionStoresData,
} from '../api/types';
import { useRecentAuthentication } from '../auth/confirm-identity';
import { useMe } from '../auth/context';
import { errorText } from '../i18n/errors';
import { formatDateTime, formatMoney } from '../i18n/format';
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
 * own currency and in this shop's at the day's rate, and all of them together.
 */
function StoreSales() {
  const { t } = useLocale();
  const [days, setDays] = useState<(typeof PERIODS)[number]>(30);
  // Up to now, as the page was opened: the same period however often it is drawn.
  const [now] = useState(() => Date.now());
  const period = useMemo(
    () => ({
      from: new Date(now - days * 86_400_000).toISOString(),
      before: new Date(now + 60_000).toISOString(),
    }),
    [now, days],
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
  return (
    <section aria-labelledby="expansion-sales" className="flex flex-col gap-2">
      <h2 id="expansion-sales" className="font-semibold">
        {t('expansion.sales')}
      </h2>
      <Card className="flex flex-col gap-3 p-4">
        <SelectField
          label={t('expansion.salesPeriod')}
          value={String(days)}
          options={PERIODS.map((each) => ({
            value: String(each),
            label: t('expansion.days', { count: each }),
          }))}
          onChange={(value) => setDays(Number(value) as (typeof PERIODS)[number])}
        />
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
            {unconverted && <p className="text-secondary">{t('expansion.salesUnconverted')}</p>}
          </>
        )}
      </Card>
    </section>
  );
}
