import { Link } from '@tanstack/react-router';
import { Check, MessageSquareText, X } from 'lucide-react';
import { useState } from 'react';
import {
  ReturnRequestApproveMutation,
  ReturnRequestDeclineMutation,
  ReturnRequestsQuery,
} from '../api/operations';
import type {
  ReturnRequestApproveData,
  ReturnRequestDeclineData,
  ReturnRequestsData,
} from '../api/types';
import { permits } from '../auth/permissions';
import { errorText } from '../i18n/errors';
import { formatCount, formatRelative } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { useAdminMutation, useAdminQuery, useShop, useShopTimezone } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, Card, EmptyState, ErrorState, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';
import { CHECKS_IN, useAttempt } from './parcel';

/** An item's name as the request has it, its variant after it unless it has none. */
const itemName = (line: { title: string; variantTitle: string }) =>
  line.variantTitle && line.variantTitle !== 'Default Title'
    ? `${line.title} · ${line.variantTitle}`
    : line.title;

/**
 * Returns shoppers asked for from their order's page (ORD-08, ADR-677), the oldest first: what
 * they would send back and why, what they would like instead and their words. Staff approve one
 * into a return of what was asked, recorded on its order to check in when it comes, or decline it
 * with the reason the shopper is told on WhatsApp (ADR-676).
 */
export function AskedReturns() {
  const { t, locale } = useLocale();
  const shop = useShop();
  const shopId = shop.id;
  const timeZone = useShopTimezone();
  const query = useAdminQuery<ReturnRequestsData>(['returnRequests'], ReturnRequestsQuery);
  const approve = useAdminMutation<ReturnRequestApproveData, { id: string }>(
    ReturnRequestApproveMutation,
  );
  const decline = useAdminMutation<ReturnRequestDeclineData, { id: string; reason: string }>(
    ReturnRequestDeclineMutation,
  );
  const { problem, attempt } = useAttempt();
  const [declining, setDeclining] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [approved, setApproved] = useState<{ orderId: string; name: string } | null>(null);
  const works = permits(shop, CHECKS_IN);

  if (query.isPending) return <Loading label={t('state.loading')} />;
  if (query.isError) return <ErrorState message={errorText(query.error, t)} />;
  const requests = query.data.returnRequests.nodes;

  return (
    <>
      {problem && <Alert tone="danger">{problem}</Alert>}
      {approved && (
        <Alert tone="success">
          {t('askedReturns.approved', { name: approved.name })}{' '}
          <Link
            to="/$shopId/orders/$orderId"
            params={{ shopId, orderId: approved.orderId }}
            className="underline"
          >
            {t('askedReturns.openOrder')}
          </Link>
        </Alert>
      )}
      {requests.length === 0 ? (
        <Card>
          <EmptyState
            icon={<MessageSquareText aria-hidden className="size-8 text-secondary" />}
            title={t('askedReturns.none')}
            body={t('askedReturns.noneHint')}
          />
        </Card>
      ) : (
        <Card>
          <ul className="divide-y divide-line">
            {requests.map((request) => (
              <li key={request.id} className="flex flex-col gap-2 px-4 py-3">
                <div className="flex items-start gap-3">
                  <span className="flex min-w-0 flex-1 flex-col gap-1">
                    <Link
                      to="/$shopId/orders/$orderId"
                      params={{ shopId, orderId: request.orderId }}
                      className="num self-start font-medium underline"
                    >
                      {request.orderName}
                    </Link>
                    <ul className="flex flex-col">
                      {request.lineItems.map((line) => (
                        <li key={line.lineItemId}>
                          <span className="num">{formatCount(line.quantity)} ×</span>{' '}
                          {itemName(line)}{' '}
                          <span className="text-secondary">
                            · {t(`orderReturns.reason.${line.returnReason}` as MessageKey)}
                          </span>
                        </li>
                      ))}
                    </ul>
                    <span className="font-medium">
                      {t(`askedReturns.wants.${request.preference}` as MessageKey)}
                    </span>
                    {request.note && (
                      <q className="text-secondary [overflow-wrap:anywhere]">{request.note}</q>
                    )}
                  </span>
                  <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
                    {formatRelative(request.createdAt, timeZone, locale)}
                  </span>
                </div>
                {works && declining !== request.id && (
                  <div className="flex flex-wrap items-center gap-3">
                    <Button
                      icon={<Check aria-hidden className="size-5" />}
                      busy={approve.isPending && approve.variables?.id === request.id}
                      onClick={() =>
                        void attempt(async () => {
                          const done = (await approve.mutateAsync({ id: request.id }))
                            .returnRequestApprove;
                          if (done.return) {
                            setApproved({ orderId: request.orderId, name: done.return.name });
                          }
                          return done;
                        })
                      }
                    >
                      {t('askedReturns.approve')}
                    </Button>
                    <Button
                      variant="secondary"
                      icon={<X aria-hidden className="size-5" />}
                      onClick={() => {
                        setDeclining(request.id);
                        setReason('');
                      }}
                    >
                      {t('askedReturns.decline')}
                    </Button>
                  </div>
                )}
                {works && declining === request.id && (
                  <form
                    className="flex flex-col gap-3"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void attempt(async () => {
                        const done = (
                          await decline.mutateAsync({ id: request.id, reason: reason.trim() })
                        ).returnRequestDecline;
                        if (done.userErrors.length === 0) setDeclining(null);
                        return done;
                      });
                    }}
                  >
                    <TextField
                      label={t('askedReturns.why')}
                      hint={t('askedReturns.whyHint')}
                      value={reason}
                      maxLength={500}
                      onChange={(event) => setReason(event.target.value)}
                    />
                    <div className="flex flex-wrap gap-3">
                      <Button
                        type="submit"
                        variant="danger"
                        busy={decline.isPending}
                        disabled={!reason.trim()}
                      >
                        {t('askedReturns.declineSend')}
                      </Button>
                      <Button variant="secondary" onClick={() => setDeclining(null)}>
                        {t('askedReturns.keep')}
                      </Button>
                    </div>
                  </form>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}
      {query.data.returnRequests.pageInfo.hasNextPage && (
        <p className="text-secondary">{t('returns.first')}</p>
      )}
    </>
  );
}
