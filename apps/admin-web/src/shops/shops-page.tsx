import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { ChevronRight, Store } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { AuthLayout } from '../auth/auth-layout';
import { ME_KEY, useMe, useSessionStore } from '../auth/context';
import type { ShopAccess } from '../auth/session';
import { errorText } from '../i18n/errors';
import { takePendingInvitation } from '../invitation/invitation-page';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { Button } from '../ui/button';
import { Alert, ErrorState, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';

/** Opening a shop (ONB-01, ONB-10): its name; Pakistan's currency and time, and Free, to start. */
function OpenShopForm({ first }: { first: boolean }) {
  const { t } = useLocale();
  const store = useSessionStore();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { shop } = await store.auth<{ shop: ShopAccess }>('/auth/shops', {
        body: { name: name.trim() },
      });
      await queryClient.invalidateQueries({ queryKey: ME_KEY });
      await navigate({ to: '/$shopId', params: { shopId: shop.id } });
    } catch (failure) {
      setError(errorText(failure, t));
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
      {error && <Alert tone="danger">{error}</Alert>}
      <Button type="submit" busy={busy}>
        {t('shops.openSubmit')}
      </Button>
    </form>
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
  // An invitation opened before signing in comes first, once signed in.
  const [invited] = useState(takePendingInvitation);
  const only = !invited && shops.length === 1 ? shops[0] : undefined;

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
        <OpenShopForm first />
      </AuthLayout>
    );
  }
  return (
    <AuthLayout title={opening ? t('shops.openTitle') : t('shops.title')}>
      {opening ? (
        <OpenShopForm first={false} />
      ) : (
        <div className="flex flex-col gap-4">
          <ul className="flex flex-col divide-y divide-line rounded-control border border-line">
            {shops.map((shop) => (
              <li key={shop.id}>
                <Link
                  to="/$shopId"
                  params={{ shopId: shop.id }}
                  className="flex min-h-14 items-center gap-3 px-3 hover:bg-canvas"
                >
                  <Store aria-hidden className="size-5 text-secondary" />
                  <span className="flex flex-1 flex-col">
                    <span className="font-medium">{shop.name}</span>
                    <span className="text-secondary">
                      {t(`shops.role.${shop.role}` as MessageKey)}
                    </span>
                  </span>
                  <ChevronRight aria-hidden className="size-5 text-secondary rtl:rotate-180" />
                </Link>
              </li>
            ))}
          </ul>
          <Button variant="secondary" onClick={() => setOpening(true)}>
            {t('shops.open')}
          </Button>
        </div>
      )}
    </AuthLayout>
  );
}
