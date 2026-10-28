import { useParams } from '@tanstack/react-router';
import { useState } from 'react';
import {
  AppPurchaseApproveMutation,
  AppPurchaseDeclineMutation,
  AppPurchaseQuery,
  BillingInvoicePayMutation,
} from '../api/operations';
import type { AppPurchaseAnswerData, AppPurchaseData, UserError } from '../api/types';
import { useRecentAuthentication } from '../auth/confirm-identity';
import { errorText } from '../i18n/errors';
import { formatMoney } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import { problemText } from '../products/product-form';
import { useAdminMutation, useAdminQuery, useShop } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, Card, EmptyState, ErrorState, Loading } from '../ui/feedback';

/**
 * Where an installed app sends the shop's owner to answer a one-time charge (DEV-05, ADR-854): which
 * app asks what, for how much. Approved, it is an invoice of Hatti's, paid at once through Hatti's
 * gateway; a test, on a development store, is paid with no money moving. Answered, the owner goes
 * back to the app.
 */
export function AppChargePage() {
  const { t } = useLocale();
  const shop = useShop();
  const { chargeId } = useParams({ from: '/$shopId/settings/apps/charges/$chargeId' });
  const query = useAdminQuery<AppPurchaseData>(['appPurchase', chargeId], AppPurchaseQuery, {
    id: chargeId,
  });
  const approve = useAdminMutation<AppPurchaseAnswerData, { id: string }>(
    AppPurchaseApproveMutation,
  );
  const decline = useAdminMutation<AppPurchaseAnswerData, { id: string }>(
    AppPurchaseDeclineMutation,
  );
  const pay = useAdminMutation<
    { billingInvoicePay: { checkoutUrl: string | null; userErrors: UserError[] } },
    { id: string }
  >(BillingInvoicePayMutation);
  const recent = useRecentAuthentication();
  const [problem, setProblem] = useState<string | null>(null);

  const onApprove = async () => {
    setProblem(null);
    await recent.run(
      async () => {
        const done = (await approve.mutateAsync({ id: chargeId })).appPurchaseOneTimeApprove!;
        if (done.userErrors[0]) {
          setProblem(problemText(done.userErrors[0], t));
          return;
        }
        if (!done.invoiceId) return;
        const { billingInvoicePay: paying } = await pay.mutateAsync({ id: done.invoiceId });
        if (paying.checkoutUrl) window.location.assign(paying.checkoutUrl);
        else if (paying.userErrors[0]) setProblem(problemText(paying.userErrors[0], t));
      },
      (failure) => setProblem(errorText(failure, t)),
    );
  };

  const onDecline = async () => {
    setProblem(null);
    try {
      const done = (await decline.mutateAsync({ id: chargeId })).appPurchaseOneTimeDecline!;
      if (done.userErrors[0]) setProblem(problemText(done.userErrors[0], t));
    } catch (failure) {
      setProblem(errorText(failure, t));
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
    const charge = query.data.appPurchaseOneTime;
    if (!charge) return <EmptyState title={t('appCharge.missing')} />;
    const price = formatMoney(charge.price.amount);
    const answered = charge.status === 'PAID' || charge.status === 'DECLINED';
    return (
      <div className="flex flex-col gap-4">
        <Card className="flex flex-col gap-2 p-4">
          <p>{t('appCharge.asks', { app: charge.appName, price })}</p>
          <p className="font-medium" dir="auto">
            {charge.name}
          </p>
        </Card>
        {charge.test && <Alert tone="info">{t('appCharge.test')}</Alert>}
        {charge.status === 'PAID' && <Alert tone="success">{t('appCharge.paid')}</Alert>}
        {charge.status === 'DECLINED' && <Alert tone="info">{t('appCharge.declined')}</Alert>}
        {charge.status === 'ACCEPTED' && <Alert tone="warning">{t('appCharge.accepted')}</Alert>}
        {!answered &&
          (shop.role === 'owner' ? (
            <div className="flex flex-wrap gap-2">
              <Button busy={approve.isPending || pay.isPending} onClick={() => void onApprove()}>
                {charge.test ? t('appCharge.approveTest') : t('appCharge.approve', { price })}
              </Button>
              <Button variant="secondary" busy={decline.isPending} onClick={() => void onDecline()}>
                {t('appCharge.decline')}
              </Button>
            </div>
          ) : (
            <p className="text-secondary">{t('appCharge.ownerOnly')}</p>
          ))}
        {problem && <Alert tone="danger">{problem}</Alert>}
        {recent.panel}
        <a
          href={charge.returnUrl}
          className="inline-flex min-h-10 items-center text-secondary underline"
        >
          {t('appCharge.back', { app: charge.appName })}
        </a>
      </div>
    );
  };

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-4 pb-8">
      <h1 className="text-[length:var(--hatti-type-display-size)] font-semibold">
        {t('appCharge.title')}
      </h1>
      {body()}
    </div>
  );
}
