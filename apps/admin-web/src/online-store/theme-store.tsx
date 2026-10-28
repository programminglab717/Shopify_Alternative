import { useState } from 'react';
import {
  BillingInvoicePayMutation,
  ThemeStoreBuyMutation,
  ThemeStoreInstallMutation,
  ThemeStoreQuery,
} from '../api/operations';
import type {
  ThemeListing,
  ThemeStoreBuyData,
  ThemeStoreData,
  ThemeStoreInstallData,
  UserError,
} from '../api/types';
import { useRecentAuthentication } from '../auth/confirm-identity';
import { errorText } from '../i18n/errors';
import { formatMoney } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import { FormSection, problemText } from '../products/product-form';
import { useAdminMutation, useAdminQuery, useShop } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, Card, ErrorState, Loading } from '../ui/feedback';

/**
 * The theme store (OS-20, ADR-853): themes by Pakistan's designers, on Hatti's themes, free or for
 * a price in rupees. A free theme, or one the shop bought, installs as a theme of the shop's, not
 * published; a paid one is bought by the owner through Hatti's gateway first, once.
 */
export function ThemeStore() {
  const { t } = useLocale();
  const shop = useShop();
  const owner = shop.role === 'owner';
  const query = useAdminQuery<ThemeStoreData>(['themeStore'], ThemeStoreQuery);
  const install = useAdminMutation<ThemeStoreInstallData, { id: string }>(
    ThemeStoreInstallMutation,
  );
  const buy = useAdminMutation<ThemeStoreBuyData, { id: string }>(ThemeStoreBuyMutation);
  const pay = useAdminMutation<
    { billingInvoicePay: { checkoutUrl: string | null; userErrors: UserError[] } },
    { id: string }
  >(BillingInvoicePayMutation);
  const recent = useRecentAuthentication();
  const [said, setSaid] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const onInstall = async (listing: ThemeListing) => {
    setSaid(null);
    setProblem(null);
    setBusy(listing.id);
    try {
      const { themeStoreInstall: done } = await install.mutateAsync({ id: listing.id });
      if (done.userErrors[0]) setProblem(problemText(done.userErrors[0], t));
      // The shop's themes are asked again as every change is made.
      else setSaid(t('themeStore.installed', { name: listing.name }));
    } catch (failure) {
      setProblem(errorText(failure, t));
    } finally {
      setBusy(null);
    }
  };

  const onBuy = async (listing: ThemeListing) => {
    setSaid(null);
    setProblem(null);
    setBusy(listing.id);
    await recent.run(
      async () => {
        const { themeStoreBuy: chosen } = await buy.mutateAsync({ id: listing.id });
        if (!chosen.invoiceId) {
          setProblem(chosen.userErrors[0] ? problemText(chosen.userErrors[0], t) : null);
          return;
        }
        const { billingInvoicePay: paying } = await pay.mutateAsync({ id: chosen.invoiceId });
        if (paying.checkoutUrl) window.location.assign(paying.checkoutUrl);
        else setProblem(paying.userErrors[0] ? problemText(paying.userErrors[0], t) : null);
      },
      (failure) => setProblem(errorText(failure, t)),
    );
    setBusy(null);
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
    const listings = query.data.themeStore;
    if (listings.length === 0) return <p className="text-secondary">{t('themeStore.none')}</p>;
    return (
      <Card>
        <ul className="divide-y divide-line" aria-label={t('themeStore.title')}>
          {listings.map((listing) => {
            const installs = listing.free || listing.bought;
            return (
              <li key={listing.id} className="flex flex-col gap-2 px-4 py-3">
                <span className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-medium" dir="auto">
                    {listing.name}
                  </span>
                  <span className="num font-medium">
                    {listing.free
                      ? t('themeStore.free')
                      : listing.bought
                        ? t('themeStore.bought')
                        : formatMoney(listing.price.amount)}
                  </span>
                </span>
                <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
                  {t('themeStore.by', { designer: listing.designer })}
                </span>
                {listing.description && (
                  <p className="text-secondary" dir="auto">
                    {listing.description}
                  </p>
                )}
                {installs ? (
                  <Button
                    variant="secondary"
                    className="self-start"
                    busy={busy === listing.id}
                    onClick={() => void onInstall(listing)}
                  >
                    {t('themeStore.install', { name: listing.name })}
                  </Button>
                ) : owner ? (
                  <Button
                    className="self-start"
                    busy={busy === listing.id}
                    onClick={() => void onBuy(listing)}
                  >
                    {t('themeStore.buy', {
                      name: listing.name,
                      price: formatMoney(listing.price.amount),
                    })}
                  </Button>
                ) : (
                  <span className="text-secondary">{t('themeStore.ownerBuys')}</span>
                )}
              </li>
            );
          })}
        </ul>
      </Card>
    );
  };

  return (
    <FormSection title={t('themeStore.title')} hint={t('themeStore.hint')}>
      <div className="flex flex-col gap-3">
        {said && <Alert tone="success">{said}</Alert>}
        {problem && <Alert tone="danger">{problem}</Alert>}
        {body()}
        {recent.panel}
      </div>
    </FormSection>
  );
}
