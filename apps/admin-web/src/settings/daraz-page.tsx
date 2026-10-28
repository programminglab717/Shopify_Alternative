import { useNavigate, useSearch } from '@tanstack/react-router';
import { RefreshCw, ShoppingBag, Unplug } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
  DarazAccountUpdateMutation,
  DarazConnectMutation,
  DarazConnectUrlQuery,
  DarazDisconnectMutation,
  DarazQuery,
  DarazSyncMutation,
  LocationsQuery,
} from '../api/operations';
import type {
  DarazAccountPayloadData,
  DarazConnectUrlData,
  DarazData,
  DarazSyncData,
} from '../api/types';
import { useSessionStore } from '../auth/context';
import { permits } from '../auth/permissions';
import { errorText } from '../i18n/errors';
import { formatDateTime } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import { problemText } from '../products/product-form';
import { useAdminMutation, useAdminQuery, useShop, useShopTimezone } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, Card, ErrorState, Loading } from '../ui/feedback';
import { CheckField, SelectField } from './settings-form';
import { BackToSettings, SETS_SETTINGS } from './settings-page';

/** The shop being connected, kept in this tab while the merchant is on Daraz's page. */
export const DARAZ_SHOP_KEY = 'hatti.daraz.shop';

/** Where Daraz sends the merchant back: the admin's own callback, outside any shop. */
export const darazCallbackUrl = () => `${window.location.origin}/daraz/callback`;

interface LocationsData {
  locations: { nodes: { id: string; name: string }[] };
}

/**
 * Daraz (CH-06, ADR-875): the shop's Daraz Seller Center account connected through Daraz's own
 * page, and then kept in step every few minutes: its SKUs' stock, and prices where asked, from a
 * location here, and its new orders brought in as the shop's own. Products are listed on Daraz by
 * the shop, under the SKUs they have here.
 */
export function DarazPage() {
  const { t, locale } = useLocale();
  const shop = useShop();
  const store = useSessionStore();
  const timezone = useShopTimezone();
  const navigate = useNavigate();
  const search = useSearch({ from: '/$shopId/settings/daraz' });
  const daraz = useAdminQuery<DarazData>(['daraz'], DarazQuery);
  const locations = useAdminQuery<LocationsData>(['locations'], LocationsQuery);
  const connect = useAdminMutation<DarazAccountPayloadData, { code: string; state: string }>(
    DarazConnectMutation,
  );
  const update = useAdminMutation<
    DarazAccountPayloadData,
    { locationId?: string; syncPrices?: boolean }
  >(DarazAccountUpdateMutation);
  const sync = useAdminMutation<DarazSyncData, Record<string, never>>(DarazSyncMutation);
  const disconnect = useAdminMutation<{ darazDisconnect: boolean }, Record<string, never>>(
    DarazDisconnectMutation,
  );
  const [said, setSaid] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [leaving, setLeaving] = useState(false);
  const sets = permits(shop, SETS_SETTINGS);
  const connecting = useRef(false);

  // Back from Daraz with its code: connected once, the code taken off the address.
  useEffect(() => {
    if (!search.code || !search.state || connecting.current) return;
    connecting.current = true;
    void connect
      .mutateAsync({ code: search.code, state: search.state })
      .then(({ darazConnect }) => {
        const error = darazConnect?.userErrors[0];
        setSaid(
          error
            ? { tone: 'danger', text: problemText(error, t) }
            : { tone: 'success', text: t('daraz.connected') },
        );
      })
      .catch((failure: unknown) => setSaid({ tone: 'danger', text: errorText(failure, t) }))
      .finally(
        () =>
          void navigate({
            to: '/$shopId/settings/daraz',
            params: { shopId: shop.id },
            search: {},
            replace: true,
          }),
      );
  }, [search.code, search.state, connect, navigate, shop.id, t]);

  const goToDaraz = async () => {
    setSaid(null);
    setLeaving(true);
    try {
      const { darazConnectUrl } = await store.graphql<DarazConnectUrlData>(
        shop.id,
        DarazConnectUrlQuery,
        { redirectUri: darazCallbackUrl() },
      );
      if (!darazConnectUrl) throw new Error(t('daraz.unavailable'));
      try {
        window.sessionStorage.setItem(DARAZ_SHOP_KEY, shop.id);
      } catch {
        // Daraz's page comes back to the shops list instead.
      }
      window.location.assign(darazConnectUrl);
    } catch (failure) {
      setLeaving(false);
      setSaid({ tone: 'danger', text: errorText(failure, t) });
    }
  };

  const body = () => {
    if (daraz.isPending || connect.isPending) return <Loading label={t('state.loading')} />;
    if (daraz.isError) {
      return (
        <ErrorState
          message={errorText(daraz.error, t)}
          action={<Button onClick={() => void daraz.refetch()}>{t('action.retry')}</Button>}
        />
      );
    }
    const { available, account } = daraz.data.daraz;
    if (!account) {
      return (
        <Card className="flex flex-col gap-3 p-4">
          <p>{available ? t('daraz.howTo') : t('daraz.unavailable')}</p>
          {available && sets && (
            <Button className="self-start" busy={leaving} onClick={() => void goToDaraz()}>
              {t('daraz.connect')}
            </Button>
          )}
        </Card>
      );
    }
    return (
      <div className="flex flex-col gap-4">
        <Card className="flex flex-col gap-3 p-4">
          <p className="font-medium">{t('daraz.account', { account: account.account })}</p>
          <p className="text-secondary">
            {account.syncedAt
              ? t('daraz.syncedAt', { at: formatDateTime(account.syncedAt, timezone, locale) })
              : t('daraz.notSynced')}
          </p>
          {account.lastError && (
            <Alert tone="warning">{t('daraz.lastError', { error: account.lastError })}</Alert>
          )}
          <SelectField
            label={t('daraz.location')}
            value={account.locationId}
            disabled={!sets}
            options={(locations.data?.locations.nodes ?? []).map((each) => ({
              value: each.id,
              label: each.name,
            }))}
            onChange={(locationId) => void update.mutateAsync({ locationId })}
          />
          <CheckField
            label={t('daraz.syncPrices')}
            hint={t('daraz.syncPricesHint')}
            checked={account.syncPrices}
            onChange={(syncPrices) => sets && void update.mutateAsync({ syncPrices })}
          />
          {sets && (
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                icon={<RefreshCw aria-hidden className="size-5" />}
                busy={sync.isPending}
                onClick={() =>
                  void sync.mutateAsync({}).then(({ darazSync }) =>
                    setSaid({
                      tone: 'success',
                      text: t('daraz.synced', {
                        imported: darazSync?.imported ?? 0,
                        pushed: darazSync?.pushed ?? 0,
                      }),
                    }),
                  )
                }
              >
                {t('daraz.syncNow')}
              </Button>
              <Button
                variant="danger"
                icon={<Unplug aria-hidden className="size-5" />}
                busy={disconnect.isPending}
                onClick={() => void disconnect.mutateAsync({})}
              >
                {t('daraz.disconnect')}
              </Button>
            </div>
          )}
        </Card>
        {account.leftOut.length > 0 && (
          <Card className="flex flex-col gap-2 p-4">
            <h2 className="font-semibold">{t('daraz.leftOut')}</h2>
            <ul className="flex flex-col divide-y divide-line">
              {account.leftOut.map((each) => (
                <li key={each.darazOrderId} className="flex flex-col py-2">
                  <span className="font-medium">{t('daraz.order', { id: each.darazOrderId })}</span>
                  <span className="text-secondary">{each.error}</span>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
    );
  };

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 pb-8">
      <BackToSettings />
      <h1 className="flex items-center gap-2 text-[length:var(--hatti-type-display-size)] font-semibold">
        <ShoppingBag aria-hidden className="size-7 text-secondary" />
        {t('settings.daraz')}
      </h1>
      <p className="text-secondary">{t('daraz.hint')}</p>
      {said && <Alert tone={said.tone}>{said.text}</Alert>}
      {body()}
    </div>
  );
}

/** Where Daraz sends the merchant back: on to the shop they were connecting, with its code. */
export function DarazCallbackPage() {
  const navigate = useNavigate();
  const search = useSearch({ from: '/daraz/callback' });
  useEffect(() => {
    let shopId: string | null;
    try {
      shopId = window.sessionStorage.getItem(DARAZ_SHOP_KEY);
      window.sessionStorage.removeItem(DARAZ_SHOP_KEY);
    } catch {
      shopId = null;
    }
    void (shopId
      ? navigate({
          to: '/$shopId/settings/daraz',
          params: { shopId },
          search: { code: search.code, state: search.state },
          replace: true,
        })
      : navigate({ to: '/shops', replace: true }));
  }, [navigate, search.code, search.state]);
  return null;
}
