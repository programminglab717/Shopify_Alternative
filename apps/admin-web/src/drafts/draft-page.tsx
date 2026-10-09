import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { CircleCheck, Copy, FilePen, MessageCircle, Pencil, Send, Trash2 } from 'lucide-react';
import { useState } from 'react';
import {
  DraftOrderCompleteMutation,
  DraftOrderDeleteMutation,
  DraftOrderLinkCreateMutation,
  DraftOrderQuery,
} from '../api/operations';
import type { DraftOrderData, DraftOrderDetail, UserError } from '../api/types';
import { errorText } from '../i18n/errors';
import { formatDate, formatMoney, formatRelative } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { FormSection, problemText } from '../products/product-form';
import { Problems } from '../settings/settings-form';
import { useAdminMutation, useAdminQuery, useShop, useShopTimezone } from '../shell/shop-context';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Alert, Card, EmptyState, ErrorState, Loading } from '../ui/feedback';
import { TAKES_DRAFTS } from './drafts-page';

/** The link just made: shown once, to copy or send on WhatsApp. */
function SentLink({ url, whatsappUrl }: { url: string; whatsappUrl: string | null }) {
  const { t } = useLocale();
  const [copied, setCopied] = useState(false);
  return (
    <Alert tone="success">
      <div className="flex flex-col gap-2">
        <span>{t('drafts.linkMade')}</span>
        <code className="num break-all rounded-control bg-canvas px-2 py-1" dir="ltr">
          {url}
        </code>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            icon={<Copy aria-hidden className="size-5" />}
            onClick={() => void navigator.clipboard?.writeText(url).then(() => setCopied(true))}
          >
            {copied ? t('staff.copied') : t('staff.copy')}
          </Button>
          {whatsappUrl && (
            <a
              href={whatsappUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex min-h-12 items-center gap-2 rounded-control border border-line bg-surface px-4 font-medium md:min-h-10"
            >
              <MessageCircle aria-hidden className="size-5" />
              {t('staff.sendOnWhatsApp')}
            </a>
          )}
        </div>
      </div>
    </Alert>
  );
}

function Actions({ draft }: { draft: DraftOrderDetail }) {
  const { t, locale } = useLocale();
  const shopId = useShop().id;
  const timezone = useShopTimezone();
  const navigate = useNavigate();
  const link = useAdminMutation<
    {
      draftOrderLinkCreate: {
        url: string | null;
        whatsappUrl: string | null;
        userErrors: UserError[];
      };
    },
    { id: string }
  >(DraftOrderLinkCreateMutation);
  const complete = useAdminMutation<
    {
      draftOrderComplete: {
        draftOrder: { order: { id: string } | null } | null;
        userErrors: UserError[];
      };
    },
    { id: string }
  >(DraftOrderCompleteMutation);
  const remove = useAdminMutation<
    { draftOrderDelete: { userErrors: UserError[] } },
    { id: string }
  >(DraftOrderDeleteMutation);
  const [sent, setSent] = useState<{ url: string; whatsappUrl: string | null } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);

  const run = async (action: () => Promise<UserError[]>) => {
    setProblems([]);
    try {
      setProblems((await action()).map((error) => problemText(error, t)));
    } catch (failure) {
      setProblems([errorText(failure, t)]);
    }
  };

  return (
    <FormSection title={t('drafts.next')}>
      {draft.linkExpiresAt && !sent && (
        <p className="text-secondary">
          {t('drafts.linkUntil', { when: formatRelative(draft.linkExpiresAt, timezone, locale) })}
        </p>
      )}
      {sent && <SentLink {...sent} />}
      <div className="flex flex-wrap gap-2">
        <Button
          icon={<Send aria-hidden className="size-5" />}
          busy={link.isPending}
          onClick={() =>
            void run(async () => {
              const { draftOrderLinkCreate } = await link.mutateAsync({ id: draft.id });
              if (draftOrderLinkCreate.url) {
                setSent({
                  url: draftOrderLinkCreate.url,
                  whatsappUrl: draftOrderLinkCreate.whatsappUrl,
                });
              }
              return draftOrderLinkCreate.userErrors;
            })
          }
        >
          {t(draft.linkExpiresAt ? 'drafts.newLink' : 'drafts.sendLink')}
        </Button>
        <Button
          variant="secondary"
          icon={<CircleCheck aria-hidden className="size-5" />}
          busy={complete.isPending}
          onClick={() =>
            void run(async () => {
              const { draftOrderComplete } = await complete.mutateAsync({ id: draft.id });
              const order = draftOrderComplete.draftOrder?.order;
              if (order) {
                await navigate({
                  to: '/$shopId/orders/$orderId',
                  params: { shopId, orderId: order.id },
                });
              }
              return draftOrderComplete.userErrors;
            })
          }
        >
          {t('drafts.complete')}
        </Button>
        {deleting ? (
          <>
            <span className="self-center">{t('drafts.deleteSure')}</span>
            <Button
              variant="destructive"
              busy={remove.isPending}
              onClick={() =>
                void run(async () => {
                  const { draftOrderDelete } = await remove.mutateAsync({ id: draft.id });
                  if (draftOrderDelete.userErrors.length === 0) {
                    await navigate({ to: '/$shopId/drafts', params: { shopId } });
                  }
                  return draftOrderDelete.userErrors;
                })
              }
            >
              {t('drafts.deleteYes')}
            </Button>
            <Button variant="tertiary" onClick={() => setDeleting(false)}>
              {t('action.back')}
            </Button>
          </>
        ) : (
          <Button
            variant="danger"
            icon={<Trash2 aria-hidden className="size-5" />}
            onClick={() => setDeleting(true)}
          >
            {t('drafts.delete')}
          </Button>
        )}
      </div>
      <p className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
        {t('drafts.nextHint')}
      </p>
      <Problems problems={problems} />
    </FormSection>
  );
}

/**
 * A draft order's page (ORD-03): what it holds and comes to; its link sent to the customer, who
 * gives or corrects the address and confirms it, or the draft placed as an order at once when
 * they agreed in the chat; deleted while open; the order it became, once placed.
 */
export function DraftPage() {
  const { t, locale } = useLocale();
  const shop = useShop();
  const timezone = useShopTimezone();
  const { draftId } = useParams({ from: '/$shopId/drafts/$draftId' });
  const query = useAdminQuery<DraftOrderData>(['draftOrder', draftId], DraftOrderQuery, {
    id: draftId,
  });

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
  if (!draft) {
    return (
      <Card>
        <EmptyState
          icon={<FilePen aria-hidden className="size-8 text-secondary" />}
          title={t('drafts.missing')}
        />
      </Card>
    );
  }
  const totals: [MessageKey, string][] = [
    ['drafts.subtotal', draft.subtotalPrice.amount],
    ['drafts.delivery', draft.totalShippingPrice.amount],
    ...(Number(draft.totalDiscounts.amount) > 0
      ? [['drafts.discount', `-${draft.totalDiscounts.amount}`] as [MessageKey, string]]
      : []),
  ];

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 pb-8">
      <Link
        to="/$shopId/drafts"
        params={{ shopId: shop.id }}
        className="inline-flex min-h-10 items-center self-start text-secondary hover:text-text"
      >
        {t('drafts.title')}
      </Link>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="num text-[length:var(--hatti-type-display-size)] font-semibold">
          {draft.name}
        </h1>
        <Badge
          colour={draft.status === 'OPEN' ? 'needsConfirmation' : 'delivered'}
          icon={draft.status === 'OPEN' ? FilePen : CircleCheck}
          label={t(draft.status === 'OPEN' ? 'drafts.statusOpen' : 'drafts.statusCompleted')}
        />
        <span className="text-secondary">
          {t(`drafts.source.${draft.source}` as MessageKey)} ·{' '}
          {formatDate(draft.createdAt, timezone, locale)}
        </span>
        <span className="flex-1" />
        {draft.status === 'OPEN' && TAKES_DRAFTS.includes(shop.role) && (
          <Link
            to="/$shopId/drafts/$draftId/edit"
            params={{ shopId: shop.id, draftId: draft.id }}
            className="inline-flex min-h-12 items-center gap-2 rounded-control border border-line bg-surface px-4 font-medium md:min-h-10"
          >
            <Pencil aria-hidden className="size-5" />
            {t('drafts.edit')}
          </Link>
        )}
      </div>
      {draft.order && (
        <Alert tone="success">
          <Link
            to="/$shopId/orders/$orderId"
            params={{ shopId: shop.id, orderId: draft.order.id }}
            className="font-medium underline"
          >
            {t('drafts.becameOrder', { order: draft.order.name })}
          </Link>
        </Alert>
      )}
      <Card>
        <ul className="divide-y divide-line">
          {draft.lineItems.map((line) => (
            <li key={line.variantId} className="flex items-baseline gap-3 px-4 py-3">
              <span className="flex min-w-0 flex-1 flex-col">
                <span dir="auto">{line.title}</span>
                {line.variantTitle && line.variantTitle !== 'Default Title' && (
                  <span className="text-secondary" dir="auto">
                    {line.variantTitle}
                  </span>
                )}
              </span>
              <span className="num text-secondary">
                {line.quantity} × {formatMoney(line.unitPrice.amount)}
              </span>
              <span className="num font-medium">{formatMoney(line.totalPrice.amount)}</span>
            </li>
          ))}
        </ul>
        <dl className="flex flex-col gap-1 border-t border-line px-4 py-3">
          {totals.map(([label, amount]) => (
            <div key={label} className="flex justify-between text-secondary">
              <dt>{t(label)}</dt>
              <dd className="num">{formatMoney(amount)}</dd>
            </div>
          ))}
          <div className="flex justify-between font-semibold">
            <dt>{t('drafts.total')}</dt>
            <dd className="num">{formatMoney(draft.totalPrice.amount)}</dd>
          </div>
          {draft.paymentMethod === 'CASH_ON_DELIVERY' &&
            draft.codAmount.amount !== draft.totalPrice.amount && (
              <div className="flex justify-between text-secondary">
                <dt>{t('drafts.atTheDoor')}</dt>
                <dd className="num">{formatMoney(draft.codAmount.amount)}</dd>
              </div>
            )}
        </dl>
      </Card>
      <FormSection title={t('drafts.address')}>
        {draft.shippingAddress ? (
          <address className="not-italic" dir="auto">
            {draft.shippingAddress.formatted.map((line) => (
              <span key={line} className="block">
                {line}
              </span>
            ))}
          </address>
        ) : (
          <p className="text-secondary">{t('drafts.noAddressYet')}</p>
        )}
        {draft.note && <p dir="auto">{draft.note}</p>}
      </FormSection>
      {draft.status === 'OPEN' && TAKES_DRAFTS.includes(shop.role) && <Actions draft={draft} />}
    </div>
  );
}
