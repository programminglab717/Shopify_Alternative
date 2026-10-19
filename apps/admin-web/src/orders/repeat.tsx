import { Link, useNavigate } from '@tanstack/react-router';
import { Ban, Merge } from 'lucide-react';
import {
  OrderCancelMutation,
  OrderMergeMutation,
  OrderRepeatKeepMutation,
} from '../api/operations';
import type {
  OrderCancelReason,
  OrderDetail,
  OrderMergeSplitData,
  OrderMutationData,
} from '../api/types';
import { permits } from '../auth/permissions';
import { useLocale } from '../i18n/locale';
import { useAttempt } from '../returns/parcel';
import { useAdminMutation, useShop } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert } from '../ui/feedback';
import { mergeable } from './merge-split';
import { WORKS_PARCELS } from './parcels';

/**
 * An order that may repeat an earlier one of its customer's (CHK-11, ADR-392), as when they
 * placed it twice: those who work orders merge it into the earlier, cancel it as a repeat, or
 * keep both. Merged, the earlier order's page opens.
 */
export function RepeatBanner({
  order,
}: {
  order: Pick<OrderDetail, 'id' | 'status' | 'repeatOf' | 'customer' | 'amountPaid'>;
}) {
  const { t } = useLocale();
  const shop = useShop();
  const navigate = useNavigate();
  const merge = useAdminMutation<OrderMergeSplitData, { id: string; intoId: string }>(
    OrderMergeMutation,
  );
  const cancel = useAdminMutation<OrderMutationData, { id: string; reason: OrderCancelReason }>(
    OrderCancelMutation,
  );
  const keep = useAdminMutation<OrderMutationData, { id: string }>(OrderRepeatKeepMutation);
  const { problem, attempt } = useAttempt();
  const earlier = order.repeatOf;
  if (!earlier || order.status !== 'OPEN') return null;
  const works = permits(shop, WORKS_PARCELS);

  const onMerge = async () => {
    const ok = await attempt(
      async () => Object.values(await merge.mutateAsync({ id: order.id, intoId: earlier.id }))[0]!,
    );
    if (ok) {
      await navigate({
        to: '/$shopId/orders/$orderId',
        params: { shopId: shop.id, orderId: earlier.id },
      });
    }
  };

  return (
    <Alert tone="warning">
      <div className="flex flex-col gap-2">
        <p>
          {t('repeat.body')}{' '}
          <Link
            to="/$shopId/orders/$orderId"
            params={{ shopId: shop.id, orderId: earlier.id }}
            className="num font-medium text-primary hover:underline"
          >
            {earlier.name}
          </Link>
        </p>
        {works && (
          <div className="flex flex-wrap gap-2">
            {mergeable(order) && (
              <Button
                variant="secondary"
                icon={<Merge aria-hidden className="size-5" />}
                busy={merge.isPending}
                onClick={() => void onMerge()}
              >
                {t('repeat.merge', { name: earlier.name })}
              </Button>
            )}
            <Button
              variant="secondary"
              icon={<Ban aria-hidden className="size-5" />}
              busy={cancel.isPending}
              onClick={() =>
                void attempt(
                  async () =>
                    Object.values(
                      await cancel.mutateAsync({ id: order.id, reason: 'DUPLICATE' }),
                    )[0]!,
                )
              }
            >
              {t('repeat.cancel')}
            </Button>
            <Button
              variant="tertiary"
              busy={keep.isPending}
              onClick={() =>
                void attempt(
                  async () => Object.values(await keep.mutateAsync({ id: order.id }))[0]!,
                )
              }
            >
              {t('repeat.keep')}
            </Button>
          </div>
        )}
        {problem && <Alert tone="danger">{problem}</Alert>}
      </div>
    </Alert>
  );
}
