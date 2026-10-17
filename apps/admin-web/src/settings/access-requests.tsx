import { Check, Handshake, X } from 'lucide-react';
import { useState } from 'react';
import {
  StaffAccessRequestApproveMutation,
  StaffAccessRequestDeclineMutation,
  StaffAccessRequestsQuery,
} from '../api/operations';
import type { StaffAccessRequest, StaffAccessRequestsData, UserError } from '../api/types';
import { useRecentAuthentication } from '../auth/confirm-identity';
import { errorText } from '../i18n/errors';
import { formatRelative } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import { problemText } from '../products/product-form';
import { useAdminMutation, useAdminQuery, useShopTimezone } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, Card } from '../ui/feedback';
import { roleLabel } from './settings-page';

/**
 * Requests for access (ADM-07, ADR-488): agencies and freelancers who asked the shop, by its
 * address, to work in it for some days, each approved in a tap, after the member confirms who they
 * are, or declined. Nothing shows while none waits.
 */
export function AccessRequests({
  run,
}: {
  run: ReturnType<typeof useRecentAuthentication>['run'];
}) {
  const { t, locale } = useLocale();
  const timezone = useShopTimezone();
  const query = useAdminQuery<StaffAccessRequestsData>(
    ['staffAccessRequests'],
    StaffAccessRequestsQuery,
  );
  const approve = useAdminMutation<
    { staffAccessRequestApprove: { userErrors: UserError[] } },
    { id: string }
  >(StaffAccessRequestApproveMutation);
  const decline = useAdminMutation<
    { staffAccessRequestDecline: { userErrors: UserError[] } },
    { id: string }
  >(StaffAccessRequestDeclineMutation);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const requests = query.data?.staffAccessRequests ?? [];
  if (requests.length === 0 && !done) return null;

  const onApprove = (request: StaffAccessRequest) => {
    setProblem(null);
    setDone(null);
    void run(
      async () => {
        const { staffAccessRequestApprove } = await approve.mutateAsync({ id: request.id });
        const [failed] = staffAccessRequestApprove.userErrors;
        if (failed) setProblem(problemText(failed, t));
        else
          setDone(t('accessRequests.approved', { name: request.name, days: request.accessDays }));
      },
      (failure) => setProblem(errorText(failure, t)),
    );
  };

  const onDecline = async (request: StaffAccessRequest) => {
    setProblem(null);
    setDone(null);
    try {
      const { staffAccessRequestDecline } = await decline.mutateAsync({ id: request.id });
      const [failed] = staffAccessRequestDecline.userErrors;
      if (failed) setProblem(problemText(failed, t));
      else setDone(t('accessRequests.declined', { name: request.name }));
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  return (
    <section aria-labelledby="staff-access-requests" className="flex flex-col gap-2">
      <h2 id="staff-access-requests" className="inline-flex items-center gap-2 font-semibold">
        <Handshake aria-hidden className="size-5" />
        {t('accessRequests.title')}
      </h2>
      {done && <Alert tone="success">{done}</Alert>}
      {problem && <Alert tone="danger">{problem}</Alert>}
      {requests.length > 0 && (
        <Card>
          <ul className="divide-y divide-line">
            {requests.map((request) => (
              <li key={request.id} className="flex flex-col gap-2 px-4 py-3">
                <span className="flex flex-col">
                  <span className="font-medium" dir="auto">
                    {request.name}
                    {request.email && (
                      <span className="text-secondary" dir="ltr">
                        {' '}
                        · {request.email}
                      </span>
                    )}
                  </span>
                  <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
                    {t('accessRequests.asks', {
                      role: t(roleLabel(request.role)),
                      days: request.accessDays,
                    })}{' '}
                    ·{' '}
                    {t('staff.expires', {
                      when: formatRelative(request.expiresAt, timezone, locale),
                    })}
                  </span>
                </span>
                {request.message && (
                  <p className="rounded-control bg-canvas p-2" dir="auto">
                    {request.message}
                  </p>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button
                    icon={<Check aria-hidden className="size-5" />}
                    disabled={approve.isPending || decline.isPending}
                    aria-label={t('accessRequests.approveName', { name: request.name })}
                    onClick={() => onApprove(request)}
                  >
                    {t('accessRequests.approve')}
                  </Button>
                  <Button
                    variant="tertiary"
                    icon={<X aria-hidden className="size-5" />}
                    disabled={approve.isPending || decline.isPending}
                    aria-label={t('accessRequests.declineName', { name: request.name })}
                    onClick={() => void onDecline(request)}
                  >
                    {t('accessRequests.decline')}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </section>
  );
}
