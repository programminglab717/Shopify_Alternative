import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { DoorOpen } from 'lucide-react';
import { useState } from 'react';
import { useRecentAuthentication } from '../auth/confirm-identity';
import { ME_KEY, useSessionStore } from '../auth/context';
import type { ClosedShopAccess, ShopAccess } from '../auth/session';
import { errorText } from '../i18n/errors';
import { formatDate } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import { Button } from '../ui/button';
import { Alert } from '../ui/feedback';

/**
 * The shops the account closed, while their data is kept: each with the day it goes, and reopened
 * at a tap, once the owner has confirmed who they are (ADR-740).
 */
export function ClosedShops({ shops }: { shops: ClosedShopAccess[] }) {
  const { t, locale } = useLocale();
  const store = useSessionStore();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { run, panel } = useRecentAuthentication();
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  if (shops.length === 0) return null;

  const reopen = (shop: ClosedShopAccess) => {
    setProblem(null);
    setBusy(shop.id);
    void run(
      async () => {
        const { shop: reopened } = await store.auth<{ shop: ShopAccess }>(
          `/auth/shops/${encodeURIComponent(shop.id)}/reopen`,
          { body: {} },
        );
        await queryClient.invalidateQueries({ queryKey: ME_KEY });
        await navigate({ to: '/$shopId', params: { shopId: reopened.id } });
      },
      (failure) => setProblem(errorText(failure, t)),
    ).finally(() => setBusy(null));
  };

  return (
    <section aria-labelledby="closed-shops" className="flex flex-col gap-2">
      <h2 id="closed-shops" className="font-semibold">
        {t('closedShops.title')}
      </h2>
      <ul className="flex flex-col divide-y divide-line rounded-control border border-line">
        {shops.map((shop) => (
          <li key={shop.id} className="flex min-h-14 items-center gap-3 px-3 py-2">
            <DoorOpen aria-hidden className="size-5 text-secondary" />
            <span className="flex flex-1 flex-col">
              <span className="font-medium" dir="auto">
                {shop.name}
              </span>
              <span className="text-secondary">
                {t('closedShops.deletes', {
                  date: formatDate(shop.deletesAt, 'Asia/Karachi', locale),
                })}
              </span>
            </span>
            <Button
              variant="secondary"
              busy={busy === shop.id}
              onClick={() => reopen(shop)}
              aria-label={t('closedShops.reopenNamed', { name: shop.name })}
            >
              {t('closedShops.reopen')}
            </Button>
          </li>
        ))}
      </ul>
      {problem && <Alert tone="danger">{problem}</Alert>}
      {panel}
    </section>
  );
}
