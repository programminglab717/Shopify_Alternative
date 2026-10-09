import { Link } from '@tanstack/react-router';
import { PackageCheck } from 'lucide-react';
import { OpenReturnsQuery, ReturnReceiveMutation } from '../api/operations';
import type { OpenReturnsData, ParcelUserErrorsData } from '../api/types';
import { errorText } from '../i18n/errors';
import { formatCount } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import { useAdminMutation, useAdminQuery, useShop } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, Card, EmptyState, ErrorState, Loading } from '../ui/feedback';
import { CHECKS_IN, SLOW_RETURN_DAYS, trackingText, useAttempt } from './parcel';

/**
 * Customer returns on their way (ORD-07, ADR-138), the longest first, a slow one in red: each
 * checked in with all of it back in stock, or opened on its order to write off what is damaged.
 */
export function CustomerReturns() {
  const { t } = useLocale();
  const { id: shopId, role } = useShop();
  const query = useAdminQuery<OpenReturnsData>(['openReturns'], OpenReturnsQuery);
  const receive = useAdminMutation<ParcelUserErrorsData, { id: string }>(ReturnReceiveMutation);
  const { problem, attempt } = useAttempt();
  const works = CHECKS_IN.includes(role);

  if (query.isPending) return <Loading label={t('state.loading')} />;
  if (query.isError) return <ErrorState message={errorText(query.error, t)} />;
  const returns = query.data.openReturns.nodes;
  if (returns.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={<PackageCheck aria-hidden className="size-8 text-success" />}
          title={t('orderReturns.noneComing')}
        />
      </Card>
    );
  }

  return (
    <>
      {problem && <Alert tone="danger">{problem}</Alert>}
      <Card>
        <ul className="divide-y divide-line">
          {returns.map((back) => {
            const slow = back.days >= SLOW_RETURN_DAYS;
            const tracking = trackingText(back.trackingInfo);
            return (
              <li key={back.id} className="flex flex-col gap-2 px-4 py-3">
                <div className="flex items-start gap-3">
                  <span className="flex min-w-0 flex-1 flex-col">
                    <Link
                      to="/$shopId/orders/$orderId"
                      params={{ shopId, orderId: back.orderId }}
                      className="num self-start font-medium underline"
                    >
                      {back.name}
                    </Link>
                    {tracking && (
                      <span
                        className="num text-secondary text-[length:var(--hatti-type-body-sm-size)]"
                        dir="ltr"
                      >
                        {tracking}
                      </span>
                    )}
                    {back.exchangeOrderName && (
                      <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
                        {t('orderReturns.exchangeNamed', { name: back.exchangeOrderName })}
                      </span>
                    )}
                  </span>
                  <span className="flex flex-col items-end text-[length:var(--hatti-type-body-sm-size)]">
                    <span className={slow ? 'font-semibold text-danger' : 'text-secondary'}>
                      {back.days === 0
                        ? t('orderReturns.today')
                        : t('orderReturns.days', { count: formatCount(back.days) })}
                    </span>
                    <span className="text-secondary">
                      {t('returns.items', { count: formatCount(back.units) })}
                    </span>
                  </span>
                </div>
                {works && (
                  <div className="flex flex-wrap items-center gap-3">
                    <Button
                      variant="secondary"
                      busy={receive.isPending && receive.variables?.id === back.id}
                      onClick={() =>
                        void attempt(
                          async () => (await receive.mutateAsync({ id: back.id })).returnReceive!,
                        )
                      }
                    >
                      {t('orderReturns.allBack')}
                    </Button>
                    <Link
                      to="/$shopId/orders/$orderId"
                      params={{ shopId, orderId: back.orderId }}
                      className="text-secondary underline"
                    >
                      {t('orderReturns.someDamaged')}
                    </Link>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </Card>
    </>
  );
}
