import { Link } from '@tanstack/react-router';
import { ArrowLeft, Bot, UserRound } from 'lucide-react';
import { useMemo, useState } from 'react';
import { startOfDay } from '../analytics/period';
import { InboxReplyTimesQuery } from '../api/operations';
import type { InboxReplierValue, InboxReplyTimesData, ReplyTimesFigures } from '../api/types';
import { gate, permits } from '../auth/permissions';
import { errorText } from '../i18n/errors';
import { formatCount } from '../i18n/format';
import { useLocale, type Translate } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { useAdminQuery, useShop, useShopTimezone } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Card, EmptyState, ErrorState, Loading } from '../ui/feedback';

/** Who sees how fast each answered: those who see staff performance, as the core has it. */
export const SEES_REPLY_TIMES = gate(['owner', 'manager'], 'see_staff_performance');

/** The periods reply times are reported over, in days: today, this week, this month. */
const PERIODS = [1, 7, 30] as const;
type Days = (typeof PERIODS)[number];

/** A wait as staff read it: "45 s", "12 min", "2 h 5 min". */
export function waitText(seconds: number, t: Translate): string {
  if (seconds < 60) return t('replyTimes.seconds', { count: formatCount(seconds) });
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return t('replyTimes.minutes', { count: formatCount(minutes) });
  return t('replyTimes.hours', {
    hours: formatCount(Math.floor(minutes / 60)),
    minutes: formatCount(minutes % 60),
  });
}

/** One figure: what it counts, its value, and what goes with it. */
function Stat({ label, value, hint }: { label: MessageKey; value: string; hint?: string }) {
  const { t } = useLocale();
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">{t(label)}</dt>
      <dd className="num text-[length:var(--hatti-type-title-size)] font-semibold">{value}</dd>
      {hint && (
        <dd className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">{hint}</dd>
      )}
    </div>
  );
}

/** The shop's or one member's figures: answers, the middle wait, and those in time. */
function Figures({ figures, target }: { figures: ReplyTimesFigures; target: number | null }) {
  const { t } = useLocale();
  return (
    <dl className="grid grid-cols-3 gap-3">
      <Stat label="replyTimes.answered" value={formatCount(figures.answered)} />
      <Stat
        label="replyTimes.median"
        value={figures.medianWaitSeconds === null ? '–' : waitText(figures.medianWaitSeconds, t)}
      />
      <Stat
        label="replyTimes.inTime"
        value={
          figures.withinTarget === null || figures.answered === 0
            ? '–'
            : `${Math.round((figures.withinTarget / figures.answered) * 100)}%`
        }
        hint={
          target === null ? undefined : t('replyTimes.inTimeHint', { minutes: formatCount(target) })
        }
      />
    </dl>
  );
}

/**
 * The inbox's reply times (MSG-06, ADR-763): today, over the last 7 or 30 days in the shop's time
 * zone, how many customers who waited on WhatsApp were answered, the middle of their waits, and
 * the share answered within the shop's time to answer; for the shop, then each member of staff or
 * app who answered, those who answered most first. Owners and managers see it.
 */
export function ReplyTimesPage() {
  const { t } = useLocale();
  const shop = useShop();
  const timezone = useShopTimezone();
  const allowed = permits(shop, SEES_REPLY_TIMES);
  const [days, setDays] = useState<Days>(7);
  const period = useMemo(
    () => ({
      from: startOfDay(timezone, days - 1).toISOString(),
      before: startOfDay(timezone, -1).toISOString(),
    }),
    [days, timezone],
  );
  const query = useAdminQuery<InboxReplyTimesData>(
    ['inboxReplyTimes'],
    InboxReplyTimesQuery,
    period,
    { enabled: allowed },
  );

  let body;
  if (!allowed) body = <EmptyState title={t('replyTimes.cannot')} />;
  else if (query.isPending) body = <Loading label={t('state.loading')} />;
  else if (query.isError) {
    body = (
      <ErrorState
        message={errorText(query.error, t)}
        action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
      />
    );
  } else if (query.data.inboxReplyTimes.answered === 0) {
    body = <EmptyState title={t('replyTimes.none')} body={t('replyTimes.noneHint')} />;
  } else {
    const report = query.data.inboxReplyTimes;
    const names = new Map((query.data.staffMembers ?? []).map((each) => [each.id, each.name]));
    const nameOf = (replier: InboxReplierValue) =>
      replier.kind === 'APP' ? t('activity.app') : (names.get(replier.id) ?? t('agents.former'));
    body = (
      <>
        <Card className="flex flex-col gap-3 p-4">
          <h2 className="font-semibold">{t('replyTimes.shop')}</h2>
          <Figures figures={report} target={report.replyTargetMinutes} />
          {report.replyTargetMinutes === null && (
            <p className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
              {t('replyTimes.noTarget')}
            </p>
          )}
        </Card>
        <ul className="flex flex-col gap-3">
          {report.repliers.map((replier) => {
            const Icon = replier.kind === 'APP' ? Bot : UserRound;
            return (
              <li key={replier.id}>
                <Card className="flex flex-col gap-3 p-4">
                  <h2 className="flex min-w-0 items-center gap-2 font-semibold">
                    <Icon aria-hidden className="size-5 shrink-0 text-secondary" />
                    <span className="truncate" dir="auto">
                      {nameOf(replier)}
                    </span>
                  </h2>
                  <Figures figures={replier} target={report.replyTargetMinutes} />
                </Card>
              </li>
            );
          })}
        </ul>
      </>
    );
  }

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4 pb-8">
      <Link
        to="/$shopId/inbox"
        params={{ shopId: shop.id }}
        className="inline-flex min-h-10 items-center gap-1 self-start text-secondary hover:text-text"
      >
        <ArrowLeft aria-hidden className="size-5 rtl:rotate-180" />
        {t('inbox.title')}
      </Link>
      <h1 className="text-[length:var(--hatti-type-display-size)] font-semibold">
        {t('replyTimes.title')}
      </h1>
      <p className="text-secondary">{t('replyTimes.hint')}</p>
      {allowed && (
        <div role="tablist" className="flex gap-2">
          {PERIODS.map((each) => (
            <button
              key={each}
              type="button"
              role="tab"
              aria-selected={days === each}
              onClick={() => setDays(each)}
              className={`min-h-10 rounded-full border px-4 ${
                days === each ? 'border-primary bg-primary text-on-primary' : 'border-line'
              }`}
            >
              {each === 1 ? t('packers.today') : t('analytics.days', { count: each })}
            </button>
          ))}
        </div>
      )}
      {body}
    </div>
  );
}
