import { Copy, Globe, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import {
  ExpansionStoreCopyMutation,
  ExpansionStoreRemoveMutation,
  ExpansionStoreSaveMutation,
  ExpansionStoresQuery,
} from '../api/operations';
import type { ExpansionStorePayloadData, ExpansionStoresData } from '../api/types';
import { useRecentAuthentication } from '../auth/confirm-identity';
import { useMe } from '../auth/context';
import { errorText } from '../i18n/errors';
import { formatDateTime } from '../i18n/format';
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
import { SelectField } from './settings-form';

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
      {recent.panel}
    </div>
  );
}
