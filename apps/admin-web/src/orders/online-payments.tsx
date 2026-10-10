/** Payments an order's customer started online (PAY-01, PAY-04), and refunds through the gateway (PAY-06). */
import { useState } from 'react';
import type { FormEvent } from 'react';
import { PaymentRefundSettleMutation } from '../api/operations';
import type {
  PaymentRefundSettleData,
  PaymentRefundValue,
  PaymentSessionValue,
} from '../api/types';
import { formatDateTime, formatMoney } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import type { Translate } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { useAttempt } from '../returns/parcel';
import { useAdminMutation, useShop } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert } from '../ui/feedback';
import { TextField } from '../ui/field';
import { HANDLES_MONEY } from './money';

/** How long the core waits for a gateway's answer to a refund before it may be settled by hand. */
export const ANSWER_MINUTES = 5;

/** Whether a refund's answer never came: unknown, or pending past its answer's time. */
export function waitsForAnswer(refund: PaymentRefundValue, now = Date.now()): boolean {
  return (
    refund.status === 'UNKNOWN' ||
    (refund.status === 'PENDING' && now - Date.parse(refund.createdAt) > ANSWER_MINUTES * 60_000)
  );
}

/**
 * A refund whose answer never came, settled as the gateway's dashboard shows it (ADR-153): given
 * back, with the dashboard's reference if staff have it, which records the order's refund; or,
 * once they say they are sure, not given back, which frees what it held to be refunded again.
 */
function Settle({
  refund,
  gateway,
  onDone,
}: {
  refund: PaymentRefundValue;
  gateway: string;
  onDone: (message: string) => void;
}) {
  const { t } = useLocale();
  const settle = useAdminMutation<
    PaymentRefundSettleData,
    { id: string; input: { refunded: boolean; reference: string | null } }
  >(PaymentRefundSettleMutation);
  const { problem, attempt } = useAttempt();
  const [choice, setChoice] = useState<'back' | 'not' | null>(null);
  const [reference, setReference] = useState('');

  const run = async (refunded: boolean) => {
    const ok = await attempt(
      async () =>
        (
          await settle.mutateAsync({
            id: refund.id,
            input: { refunded, reference: refunded ? reference.trim() || null : null },
          })
        ).paymentRefundSettle,
    );
    if (ok) {
      onDone(
        refunded
          ? t('online.refund.settledBack', { amount: formatMoney(refund.amount.amount) })
          : t('online.refund.settledNot'),
      );
    }
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    void run(true);
  };

  return (
    <div className="flex flex-col gap-2">
      <span>{t('online.refund.check', { gateway })}</span>
      {choice === 'back' ? (
        <form onSubmit={onSubmit} className="flex flex-col gap-2">
          <TextField
            label={t('online.refund.reference', { gateway })}
            ltr
            value={reference}
            onChange={(event) => setReference(event.target.value)}
          />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" busy={settle.isPending}>
              {t('online.refund.save')}
            </Button>
            <Button variant="tertiary" onClick={() => setChoice(null)}>
              {t('returns.cancel')}
            </Button>
          </div>
        </form>
      ) : choice === 'not' ? (
        <div className="flex flex-col gap-2">
          <span>{t('online.refund.notSure', { gateway })}</span>
          <div className="flex flex-wrap gap-2">
            <Button busy={settle.isPending} onClick={() => void run(false)}>
              {t('online.refund.saveNot')}
            </Button>
            <Button variant="tertiary" onClick={() => setChoice(null)}>
              {t('returns.cancel')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => setChoice('back')}>
            {t('online.refund.givenBack')}
          </Button>
          <Button variant="secondary" onClick={() => setChoice('not')}>
            {t('online.refund.notGivenBack')}
          </Button>
        </div>
      )}
      {problem && <Alert tone="danger">{problem}</Alert>}
    </div>
  );
}

const cents = (amount: string) => Math.round(Number(amount) * 100);

/** What became of a payment started online, in the merchant's words. */
function sessionStatus(session: PaymentSessionValue, t: Translate) {
  if (session.status === 'FAILED') return t('online.failed', { error: session.error ?? '' });
  if (session.status === 'OPEN') return t('online.open');
  return t('online.paid', {
    amount: formatMoney((session.paidAmount ?? session.amount).amount),
  });
}

/**
 * What of a paid payment was paid on the order, where not all of it: nothing of a test payment,
 * and at most what the order owed, the rest on its timeline to give back.
 */
function appliedText(session: PaymentSessionValue, t: Translate): string | null {
  if (session.environment === 'SANDBOX') return t('online.sandboxPaid');
  const paid = session.paidAmount ?? session.amount;
  if (!session.applied || cents(session.applied.amount) >= cents(paid.amount)) return null;
  return cents(session.applied.amount) === 0
    ? t('online.noneApplied')
    : t('online.applied', { amount: formatMoney(session.applied.amount) });
}

/**
 * The payments the order's customer started online from its page, the latest first: through
 * which gateway, for how much, whether paid and how, what of it was paid on the order; and the
 * refunds asked of the gateway, those whose answer never came settled by owners and managers.
 */
export function OnlinePayments({
  sessions,
  timezone,
}: {
  sessions: readonly PaymentSessionValue[];
  timezone: string;
}) {
  const { t, locale } = useLocale();
  const { role } = useShop();
  const settles = HANDLES_MONEY.includes(role);
  const [said, setSaid] = useState('');

  return (
    <div className="flex flex-col gap-2 border-t border-line pt-3">
      <span className="font-medium">{t('online.title')}</span>
      {said && <Alert tone="success">{said}</Alert>}
      <ul className="flex flex-col divide-y divide-line">
        {sessions.map((session) => {
          const applied = session.status === 'PAID' ? appliedText(session, t) : null;
          return (
            <li key={session.id} className="flex flex-col gap-1 py-2">
              <span className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="flex items-center gap-2 font-medium">
                  {session.gatewayName}
                  {session.environment === 'SANDBOX' && (
                    <span className="rounded-full bg-canvas px-2 text-[length:var(--hatti-type-body-sm-size)] font-medium text-warning">
                      {t('gateways.sandboxBadge')}
                    </span>
                  )}
                </span>
                <span className="num">{formatMoney(session.amount.amount)}</span>
              </span>
              <span
                className={
                  session.status === 'PAID'
                    ? 'text-success'
                    : session.status === 'FAILED'
                      ? 'text-danger'
                      : 'text-secondary'
                }
              >
                {sessionStatus(session, t)}
              </span>
              {applied && <span className="text-secondary">{applied}</span>}
              <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
                {formatDateTime(session.paidAt ?? session.createdAt, timezone, locale)}
                {session.method && ` · ${session.method}`}
                {session.reference && (
                  <>
                    {' · '}
                    <span dir="ltr">{session.reference}</span>
                  </>
                )}
              </span>
              {session.refunds.length > 0 && (
                <ul className="flex flex-col gap-2 ps-3">
                  {session.refunds.map((refund) => {
                    const amount = formatMoney(refund.amount.amount);
                    const waiting = waitsForAnswer(refund);
                    return (
                      <li key={refund.id} className="flex flex-col gap-1">
                        <span className={refund.status === 'REFUSED' ? 'text-danger' : ''}>
                          {t(
                            refund.status === 'PENDING' && waiting
                              ? 'online.refund.late'
                              : (`online.refund.${refund.status}` as MessageKey),
                            { amount, gateway: session.gatewayName, error: refund.error ?? '' },
                          )}
                          {refund.status === 'REFUNDED' && refund.reference && (
                            <>
                              {' · '}
                              <span dir="ltr">{refund.reference}</span>
                            </>
                          )}
                        </span>
                        {waiting && settles && (
                          <Settle refund={refund} gateway={session.gatewayName} onDone={setSaid} />
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
