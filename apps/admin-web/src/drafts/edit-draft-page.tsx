/** An open draft changed, as a chat's order changes before it is placed (ORD-03). */
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { DraftOrderQuery, DraftOrderUpdateMutation } from '../api/operations';
import type { DraftOrderData, DraftOrderDetail, DraftSource, UserError } from '../api/types';
import { errorText } from '../i18n/errors';
import { formatPhone } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import { priceText } from '../products/product-form';
import { useAdminMutation, useAdminQuery, useShop } from '../shell/shop-context';
import { Button } from '../ui/button';
import { EmptyState, ErrorState, Loading } from '../ui/feedback';
import { TAKES_DRAFTS } from './drafts-page';
import { DraftForm } from './new-draft-page';
import type { DraftValues } from './new-draft-page';

const SOURCES: readonly string[] = ['WHATSAPP', 'INSTAGRAM', 'FACEBOOK', 'MANUAL'];

/** An amount for a field, empty where it is nothing. */
const amountText = (amount: string) => (Number(amount) > 0 ? priceText(amount) : '');

/** The draft as its form starts: each line at the price agreed, its charges and its address. */
export function valuesOf(draft: DraftOrderDetail): DraftValues {
  const address = draft.shippingAddress;
  return {
    lines: draft.lineItems.map((line) => ({
      variantId: line.variantId,
      title:
        line.variantTitle && line.variantTitle !== 'Default Title'
          ? `${line.title} · ${line.variantTitle}`
          : line.title,
      price: line.unitPrice,
      agreed: priceText(line.unitPrice.amount),
      quantity: line.quantity,
    })),
    source: (SOURCES.includes(draft.source) ? draft.source : 'MANUAL') as DraftSource,
    payment: draft.paymentMethod,
    delivery: amountText(draft.totalShippingPrice.amount),
    discount: amountText(draft.totalDiscounts.amount),
    note: draft.note,
    address: address && {
      name: address.name ?? '',
      phone: address.phone ? formatPhone(address.phone) : '',
      city: address.city,
      address1: address.address1 ?? '',
      rest: {
        address2: address.address2,
        landmark: address.landmark,
        province: address.province,
        zip: address.zip,
        latitude: address.latitude,
        longitude: address.longitude,
      },
    },
  };
}

/**
 * An open draft's items, prices, charges, note and address changed (ORD-03, ADR-334), for those
 * who take drafts: the form starts from the draft as it is, and the draft's page opens once it
 * is saved.
 */
export function EditDraftPage() {
  const { t } = useLocale();
  const shop = useShop();
  const navigate = useNavigate();
  const { draftId } = useParams({ from: '/$shopId/drafts/$draftId/edit' });
  const query = useAdminQuery<DraftOrderData>(['draftOrder', draftId], DraftOrderQuery, {
    id: draftId,
  });
  const update = useAdminMutation<
    { draftOrderUpdate: { draftOrder: { id: string } | null; userErrors: UserError[] } },
    { id: string; input: Record<string, unknown> }
  >(DraftOrderUpdateMutation);

  const back = (
    <Link
      to="/$shopId/drafts/$draftId"
      params={{ shopId: shop.id, draftId }}
      className="mx-auto inline-flex min-h-10 w-full max-w-3xl items-center gap-1 text-secondary hover:text-text"
    >
      <ArrowLeft aria-hidden className="size-5 rtl:rotate-180" />
      {query.data?.draftOrder?.name ?? t('drafts.title')}
    </Link>
  );

  if (!TAKES_DRAFTS.includes(shop.role)) return <EmptyState title={t('drafts.cannot')} />;
  if (query.isPending) return <Loading label={t('state.loading')} />;
  if (query.isError) {
    return (
      <ErrorState
        message={errorText(query.error, t)}
        action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
      />
    );
  }
  const draft = query.data.draftOrder;
  if (!draft) return <EmptyState title={t('drafts.missing')} />;
  if (draft.status !== 'OPEN') {
    return (
      <div className="flex flex-col gap-4">
        {back}
        <EmptyState title={t('drafts.closed')} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {back}
      <DraftForm
        title={t('drafts.editTitle', { name: draft.name })}
        initial={valuesOf(draft)}
        submitLabel={t('drafts.saveChanges')}
        editing
        save={async (input) => {
          const { draftOrderUpdate } = await update.mutateAsync({ id: draft.id, input });
          if (draftOrderUpdate.userErrors.length === 0) {
            await navigate({
              to: '/$shopId/drafts/$draftId',
              params: { shopId: shop.id, draftId: draft.id },
            });
          }
          return draftOrderUpdate.userErrors;
        }}
      />
    </div>
  );
}
