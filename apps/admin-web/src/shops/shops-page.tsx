import { useQueries, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { ChevronRight, Handshake, Store } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { ApiError } from '../api/client';
import { ShopGlanceQuery } from '../api/operations';
import type { ShopGlanceData } from '../api/types';
import { AuthLayout } from '../auth/auth-layout';
import { ME_KEY, useMe, useSessionStore } from '../auth/context';
import type { ShopAccess } from '../auth/session';
import { errorText } from '../i18n/errors';
import { formatMoney } from '../i18n/format';
import { takePendingInvitation } from '../invitation/invitation-page';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { Button } from '../ui/button';
import { Alert, ErrorState, Loading } from '../ui/feedback';
import { forgetReferral, referralCode, rememberReferral } from './referral';
import { TextField } from '../ui/field';
import { ClosedShops } from './closed-shops';
import { TermsAgreement, useTermsAgreement } from './terms-agreement';

/** Opening a shop (ONB-01, ONB-10): its name; Pakistan's currency and time, and Free, to start. */
function OpenShopForm({ first }: { first: boolean }) {
  const { t } = useLocale();
  const store = useSessionStore();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Hatti's terms, agreed to in opening it (ADR-737).
  const agreement = useTermsAgreement();

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!agreement.agreed) return;
    setBusy(true);
    setError(null);
    try {
      // Brought by a partner's link (ADR-505): the shop is theirs, as referred.
      const referral = referralCode();
      const { shop } = await store.auth<{ shop: ShopAccess }>('/auth/shops', {
        body: {
          name: name.trim(),
          agreed: agreement.agreed,
          ...(referral && { referralCode: referral }),
        },
      });
      forgetReferral();
      await queryClient.invalidateQueries({ queryKey: ME_KEY });
      await navigate({ to: '/$shopId', params: { shopId: shop.id } });
    } catch (failure) {
      setError(errorText(failure, t));
      if (failure instanceof ApiError && failure.code === 'TERMS_CHANGED') {
        await agreement.refresh();
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-4">
      {first && <p className="text-secondary">{t('shops.openBody')}</p>}
      <TextField
        label={t('shops.name')}
        value={name}
        onChange={(e) => setName(e.target.value)}
        autoFocus={first}
        required
      />
      <TermsAgreement agreement={agreement} />
      {error && <Alert tone="danger">{error}</Alert>}
      <Button type="submit" busy={busy}>
        {t('shops.openSubmit')}
      </Button>
    </form>
  );
}

/** For an agency or a freelancer: asking a shop for access instead (ADR-488). */
function AskAccessLink() {
  const { t } = useLocale();
  return (
    <Link
      to="/access"
      className="mt-4 inline-flex min-h-10 items-center gap-2 self-center text-secondary underline"
    >
      <Handshake aria-hidden className="size-5" />
      {t('shops.askAccess')}
    </Link>
  );
}

/** For an agency that builds stores for others: Hatti's partner programme (ADR-504). */
function PartnersLink() {
  const { t } = useLocale();
  return (
    <Link
      to="/partners"
      className="inline-flex min-h-10 items-center gap-2 self-center text-secondary underline"
    >
      <Store aria-hidden className="size-5" />
      {t('shops.partners')}
    </Link>
  );
}

/**
 * The account's shops at a glance (ADM-06, ADR-841), for one who works in more than one: each
 * shop's sales today and the orders waiting to be confirmed and packed, read as each shop's home
 * reads them, and what they come to together. A shop the member can't read orders of says
 * nothing of them, and counts for nothing in the totals.
 */
function useGlances(shops: readonly ShopAccess[]) {
  const store = useSessionStore();
  return useQueries({
    queries: shops.map((shop) => ({
      queryKey: ['glance', shop.id],
      queryFn: () => store.graphql<ShopGlanceData>(shop.id, ShopGlanceQuery),
      retry: false,
      staleTime: 60_000,
    })),
  });
}

function GlanceTotals({ glances }: { glances: (ShopGlanceData | undefined)[] }) {
  const { t } = useLocale();
  const read = glances.filter((each): each is ShopGlanceData => each !== undefined);
  if (read.length === 0) return null;
  const sum = (of: (glance: ShopGlanceData) => number) =>
    read.reduce((total, glance) => total + of(glance), 0);
  const sales = sum((glance) => Number(glance.home.today.sales.total.amount));
  return (
    <section
      aria-label={t('shops.glance')}
      className="grid grid-cols-3 gap-2 rounded-control border border-line p-3 text-center"
    >
      <p className="flex flex-col">
        <span className="num font-semibold">{formatMoney(sales.toFixed(2))}</span>
        <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
          {t('shops.glanceSales', { count: sum((glance) => glance.home.today.sales.count) })}
        </span>
      </p>
      <p className="flex flex-col">
        <span className="num font-semibold">{sum((glance) => glance.home.toConfirm.count)}</span>
        <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
          {t('shops.glanceToConfirm')}
        </span>
      </p>
      <p className="flex flex-col">
        <span className="num font-semibold">{sum((glance) => glance.home.toPack.count)}</span>
        <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
          {t('shops.glanceToPack')}
        </span>
      </p>
    </section>
  );
}

/**
 * The shops the account works in, each with its role there: one alone opens at once; none asks
 * for the merchant's first.
 */
export function ShopsPage() {
  const { t } = useLocale();
  const me = useMe();
  const navigate = useNavigate();
  const [opening, setOpening] = useState(false);
  const shops = me.data?.shops ?? [];
  const closed = me.data?.closedShops ?? [];
  // An invitation opened before signing in comes first, once signed in.
  const [invited] = useState(takePendingInvitation);
  // As does a partner's referral link to this page (ADR-505).
  useState(() => rememberReferral());
  const only = !invited && shops.length === 1 && closed.length === 0 ? shops[0] : undefined;
  // Read only for an account of more than one shop.
  const glances = useGlances(shops.length > 1 ? shops : []);

  useEffect(() => {
    if (invited) {
      void navigate({ to: '/invitation', hash: `token=${invited}`, replace: true });
    } else if (only) {
      void navigate({ to: '/$shopId', params: { shopId: only.id }, replace: true });
    }
  }, [invited, only, navigate]);

  if (me.isPending || only || invited) {
    return (
      <AuthLayout title={t('shops.title')}>
        <Loading label={t('state.loading')} />
      </AuthLayout>
    );
  }
  if (me.isError) {
    return (
      <AuthLayout title={t('shops.title')}>
        <ErrorState
          message={errorText(me.error, t)}
          action={<Button onClick={() => void me.refetch()}>{t('action.retry')}</Button>}
        />
      </AuthLayout>
    );
  }
  if (shops.length === 0) {
    return (
      <AuthLayout title={t('shops.openTitle')}>
        <ClosedShops shops={closed} />
        <OpenShopForm first />
        <AskAccessLink />
        <PartnersLink />
      </AuthLayout>
    );
  }
  return (
    <AuthLayout title={opening ? t('shops.openTitle') : t('shops.title')}>
      {opening ? (
        <OpenShopForm first={false} />
      ) : (
        <div className="flex flex-col gap-4">
          {shops.length > 1 && <GlanceTotals glances={glances.map((each) => each.data)} />}
          <ul className="flex flex-col divide-y divide-line rounded-control border border-line">
            {shops.map((shop, index) => (
              <li key={shop.id}>
                <Link
                  to="/$shopId"
                  params={{ shopId: shop.id }}
                  className="flex min-h-14 items-center gap-3 px-3 hover:bg-canvas"
                >
                  <Store aria-hidden className="size-5 text-secondary" />
                  <span className="flex flex-1 flex-col">
                    <span className="font-medium">{shop.name}</span>
                    <span className="text-secondary" dir="auto">
                      {shop.customRole?.name ?? t(`shops.role.${shop.role}` as MessageKey)}
                    </span>
                    {glances[index]?.data && (
                      <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
                        {t('shops.glanceShop', {
                          sales: formatMoney(glances[index].data.home.today.sales.total.amount),
                          toConfirm: glances[index].data.home.toConfirm.count,
                          toPack: glances[index].data.home.toPack.count,
                        })}
                      </span>
                    )}
                  </span>
                  <ChevronRight aria-hidden className="size-5 text-secondary rtl:rotate-180" />
                </Link>
              </li>
            ))}
          </ul>
          <ClosedShops shops={closed} />
          <Button variant="secondary" onClick={() => setOpening(true)}>
            {t('shops.open')}
          </Button>
          <AskAccessLink />
          <PartnersLink />
        </div>
      )}
    </AuthLayout>
  );
}
