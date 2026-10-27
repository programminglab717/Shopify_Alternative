import { Link } from '@tanstack/react-router';
import { CircleCheck, CircleOff, Gift, Save } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { ReferralProgramUpdateMutation, ReferralsQuery } from '../api/operations';
import type {
  ReferralProgramUpdateData,
  ReferralProgramValue,
  ReferralsData,
  ReferralValue,
} from '../api/types';
import { errorText } from '../i18n/errors';
import { formatDate, formatMoney } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { problemText } from '../products/product-form';
import { CheckField, parseWhole } from '../settings/settings-form';
import { useAdminMutation, useAdminQuery, useShop, useShopTimezone } from '../shell/shop-context';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Alert, Card, EmptyState, ErrorState, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';
import { BackToMarketing } from './templates-page';

/** The days the credit may last (ADR-807). */
const CREDIT_DAYS = { min: 7, max: 365 } as const;

/** An amount as the core gives it, "200.00", as a merchant types it, "200". */
const rupeesOf = (amount: string) => amount.replace(/\.00$/, '');

/** Whether a merchant's rupees read as an amount of zero or more: "1,500" or "200.50". */
const isRupees = (text: string) => /^\d[\d,]*(\.\d{1,2})?$/.test(text.trim());

/** The programme's form: on or off, each side's credit, its days and the friend's minimum. */
function ProgramForm({ program }: { program: ReferralProgramValue }) {
  const { t } = useLocale();
  const update = useAdminMutation<ReferralProgramUpdateData, { input: object }>(
    ReferralProgramUpdateMutation,
  );
  const [enabled, setEnabled] = useState(program.enabled);
  const [referrer, setReferrer] = useState(rupeesOf(program.referrerCredit.amount));
  const [friend, setFriend] = useState(rupeesOf(program.friendCredit.amount));
  const [days, setDays] = useState(String(program.creditDays));
  const [minimum, setMinimum] = useState(rupeesOf(program.minimumOrder.amount));
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const changed =
    enabled !== program.enabled ||
    referrer.trim() !== rupeesOf(program.referrerCredit.amount) ||
    friend.trim() !== rupeesOf(program.friendCredit.amount) ||
    days.trim() !== String(program.creditDays) ||
    minimum.trim() !== rupeesOf(program.minimumOrder.amount);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!changed) return;
    setProblem(null);
    setSaved(false);
    const lasts = parseWhole(days);
    if (
      ![referrer, friend, minimum].every(isRupees) ||
      lasts === null ||
      Number.isNaN(lasts) ||
      lasts < CREDIT_DAYS.min ||
      lasts > CREDIT_DAYS.max
    ) {
      setProblem(t('referrals.badInput'));
      return;
    }
    try {
      const { referralProgramUpdate } = await update.mutateAsync({
        input: {
          enabled,
          referrerCredit: referrer.trim(),
          friendCredit: friend.trim(),
          creditDays: lasts,
          minimumOrder: minimum.trim(),
        },
      });
      const error = referralProgramUpdate.userErrors[0];
      if (error) {
        setProblem(problemText(error, t));
        return;
      }
      const kept = referralProgramUpdate.referralProgram;
      if (kept) {
        // As the core keeps them: "1,500" saved reads "1500".
        setReferrer(rupeesOf(kept.referrerCredit.amount));
        setFriend(rupeesOf(kept.friendCredit.amount));
        setMinimum(rupeesOf(kept.minimumOrder.amount));
      }
      setSaved(true);
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  return (
    <Card className="p-4">
      <form onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-3">
        <TextField
          label={t('referrals.referrerCredit')}
          inputMode="decimal"
          ltr
          value={referrer}
          onChange={(event) => setReferrer(event.target.value)}
        />
        <TextField
          label={t('referrals.friendCredit')}
          hint={t('referrals.friendHint')}
          inputMode="decimal"
          ltr
          value={friend}
          onChange={(event) => setFriend(event.target.value)}
        />
        <TextField
          label={t('referrals.creditDays')}
          inputMode="numeric"
          ltr
          value={days}
          onChange={(event) => setDays(event.target.value)}
        />
        <TextField
          label={t('referrals.minimumOrder')}
          hint={t('referrals.minimumHint')}
          inputMode="decimal"
          ltr
          value={minimum}
          onChange={(event) => setMinimum(event.target.value)}
        />
        <p className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
          {t('referrals.checks', { perMonth: program.perMonth })}
        </p>
        <CheckField label={t('referrals.on')} checked={enabled} onChange={setEnabled} />
        {problem && <Alert tone="danger">{problem}</Alert>}
        {saved && !changed && <Alert tone="success">{t('referrals.saved')}</Alert>}
        <Button
          type="submit"
          className="self-start"
          busy={update.isPending}
          disabled={!changed}
          icon={<Save aria-hidden className="size-5" />}
        >
          {t('referrals.save')}
        </Button>
      </form>
    </Card>
  );
}

/** A referral: when, what became of it and why, and its order and customers. */
function ReferralRow({ referral }: { referral: ReferralValue }) {
  const { t, locale } = useLocale();
  const shopId = useShop().id;
  const timezone = useShopTimezone();
  const rewarded = referral.outcome === 'REWARDED';
  return (
    <li className="flex flex-col gap-2 border-t border-line px-4 py-3 first:border-t-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="num">{formatDate(referral.createdAt, timezone, locale)}</span>
        {rewarded ? (
          <Badge colour="delivered" icon={CircleCheck} label={t('referrals.rewarded')} />
        ) : (
          <Badge colour="returned" icon={CircleOff} label={t('referrals.refused')} />
        )}
      </div>
      <span className="text-secondary">
        {rewarded
          ? t('referrals.given', {
              referrer: formatMoney(referral.referrerCredit.amount),
              friend: formatMoney(referral.friendCredit.amount),
            })
          : t(`referrals.reason.${referral.reason}` as MessageKey)}
      </span>
      <span className="flex flex-wrap gap-x-4 gap-y-1">
        <Link
          to="/$shopId/orders/$orderId"
          params={{ shopId, orderId: referral.orderId }}
          className="text-primary underline"
        >
          {t('referrals.order')}
        </Link>
        <Link
          to="/$shopId/customers/$customerId"
          params={{ shopId, customerId: referral.referrerId }}
          className="text-primary underline"
        >
          {t('referrals.referrer')}
        </Link>
        <Link
          to="/$shopId/customers/$customerId"
          params={{ shopId, customerId: referral.friendId }}
          className="text-primary underline"
        >
          {t('referrals.friend')}
        </Link>
      </span>
    </li>
  );
}

/**
 * Referrals (MKT-07, ADR-808): the shop's programme, each side's store credit once a friend's
 * first order from a customer's link arrives, and the referrals its links brought, rewarded or
 * refused by the checks against fraud, with why.
 */
export function ReferralsPage() {
  const { t } = useLocale();
  const query = useAdminQuery<ReferralsData>(['referrals'], ReferralsQuery);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 pb-8">
      <BackToMarketing />
      <h1 className="flex items-center gap-2 text-[length:var(--hatti-type-display-size)] font-semibold">
        <Gift aria-hidden className="size-7 text-secondary" />
        {t('referrals.title')}
      </h1>
      <p className="text-secondary">{t('referrals.intro')}</p>
      {query.isPending ? (
        <Loading label={t('state.loading')} />
      ) : query.isError ? (
        <ErrorState
          message={errorText(query.error, t)}
          action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
        />
      ) : (
        <>
          <ProgramForm program={query.data.referralProgram} />
          <h2 className="font-semibold">{t('referrals.list')}</h2>
          {query.data.referrals.length === 0 ? (
            <EmptyState title={t('referrals.none')} />
          ) : (
            <Card>
              <ul>
                {query.data.referrals.map((referral) => (
                  <ReferralRow key={referral.orderId} referral={referral} />
                ))}
              </ul>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
