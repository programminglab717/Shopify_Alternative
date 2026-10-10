import { Link } from '@tanstack/react-router';
import { ArrowLeft, Bot, UserRound } from 'lucide-react';
import { useState } from 'react';
import { HIGH_RETURNS, percent } from '../analytics/cod-health';
import { type Days, PeriodTabs, usePeriod } from '../analytics/period';
import { ConfirmationAgentsQuery } from '../api/operations';
import type { ConfirmationAgentValue, ConfirmationAgentsData } from '../api/types';
import type { StaffRole } from '../auth/session';
import { errorText } from '../i18n/errors';
import { formatCount } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { useAdminQuery, useShop } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Card, EmptyState, ErrorState, Loading } from '../ui/feedback';

/** The roles that see how each agent of the desk did: those who run it, as the core has it. */
export const SEES_AGENTS: readonly StaffRole[] = ['owner', 'manager'];

/** One of an agent's figures: what it counts, how many, and what that is of. */
function Stat({
  label,
  value,
  hints = [],
  bad = false,
}: {
  label: MessageKey;
  value: string;
  hints?: readonly string[];
  bad?: boolean;
}) {
  const { t } = useLocale();
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">{t(label)}</dt>
      <dd
        className={`num text-[length:var(--hatti-type-title-size)] font-semibold ${
          bad ? 'text-danger' : ''
        }`}
      >
        {value}
      </dd>
      {hints.map((hint) => (
        <dd key={hint} className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
          {hint}
        </dd>
      ))}
    </div>
  );
}

/**
 * An agent over the period: a member of staff by name, or as former staff once they have gone; an
 * app, told apart from another by the end of its token. What they settled and how fast, their
 * calls that settled nothing, and how many parcels of the orders they confirmed came back.
 */
function Agent({ agent, name }: { agent: ConfirmationAgentValue; name: string | undefined }) {
  const { t } = useLocale();
  const { calls, delivery } = agent;
  const app = agent.kind === 'APP';
  const Icon = app ? Bot : UserRound;
  return (
    <li>
      <Card className="flex flex-col gap-3 p-4">
        <h2 className="flex min-w-0 items-center gap-2 font-semibold">
          <Icon aria-hidden className="size-5 shrink-0 text-secondary" />
          <span className="truncate" dir="auto">
            {app ? t('activity.app') : (name ?? t('agents.former'))}
          </span>
          {app && (
            <span dir="ltr" className="font-normal text-secondary">
              …{agent.id.slice(-6)}
            </span>
          )}
        </h2>
        <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat
            label="agents.confirmed"
            value={formatCount(agent.confirmed)}
            hints={
              agent.confirmationRate === null
                ? []
                : [t('agents.rate', { rate: percent(agent.confirmationRate) })]
            }
          />
          <Stat label="agents.cancelled" value={formatCount(agent.cancelled)} />
          <Stat
            label="agents.perHour"
            value={
              agent.confirmationsPerHour === null ? '–' : agent.confirmationsPerHour.toFixed(1)
            }
            hints={[t('agents.hours', { count: agent.activeHours })]}
          />
          <Stat
            label="agents.returned"
            value={percent(delivery.returnRate)}
            bad={(delivery.returnRate ?? 0) >= HIGH_RETURNS}
            hints={[
              t('agents.returnedOf', {
                returned: formatCount(delivery.returned),
                count: formatCount(delivery.delivered + delivery.returned),
              }),
              ...(delivery.inTransit > 0
                ? [t('agents.inTransit', { count: delivery.inTransit })]
                : []),
            ]}
          />
        </dl>
        <p className="flex flex-wrap gap-x-3 gap-y-1 text-[length:var(--hatti-type-body-sm-size)]">
          <span className="text-secondary">{t('agents.calls')}</span>
          <span>{t('agents.noAnswer', { count: calls.noAnswer })}</span>
          <span>{t('agents.callBack', { count: calls.callBack })}</span>
          <span>{t('agents.wrongNumber', { count: calls.wrongNumber })}</span>
        </p>
      </Card>
    </li>
  );
}

/**
 * Agents' performance (COD-11, ADR-090), for owners and managers: over the last 7, 30 or 90 days,
 * each agent of the Confirmation Desk with the orders they confirmed and cancelled, how many an
 * hour on the desk, their calls that settled nothing, and how many parcels of the orders they
 * confirmed came back, a high share in red; those who settled most first, as the core works it out.
 */
export function AgentsPage() {
  const { t } = useLocale();
  const shop = useShop();
  const allowed = SEES_AGENTS.includes(shop.role);
  const [days, setDays] = useState<Days>(30);
  const { from, before } = usePeriod(days);
  const query = useAdminQuery<ConfirmationAgentsData>(
    ['confirmationAgents'],
    ConfirmationAgentsQuery,
    { from, before },
    { enabled: allowed },
  );

  let body;
  if (!allowed) body = <EmptyState title={t('agents.cannot')} />;
  else if (query.isPending) body = <Loading label={t('state.loading')} />;
  else if (query.isError) {
    body = (
      <ErrorState
        message={errorText(query.error, t)}
        action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
      />
    );
  } else if (query.data.confirmationAgents.length === 0) {
    body = <EmptyState title={t('agents.none')} />;
  } else {
    const names = new Map(query.data.staffMembers.map((member) => [member.id, member.name]));
    body = (
      <ul className="flex flex-col gap-3">
        {query.data.confirmationAgents.map((agent) => (
          <Agent key={agent.id} agent={agent} name={names.get(agent.id)} />
        ))}
      </ul>
    );
  }

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4 pb-8">
      <Link
        to="/$shopId/desk"
        params={{ shopId: shop.id }}
        className="inline-flex min-h-10 items-center gap-1 self-start text-secondary hover:text-text"
      >
        <ArrowLeft aria-hidden className="size-5 rtl:rotate-180" />
        {t('desk.title')}
      </Link>
      <h1 className="text-[length:var(--hatti-type-display-size)] font-semibold">
        {t('agents.title')}
      </h1>
      <p className="text-secondary">{t('agents.hint')}</p>
      {allowed && <PeriodTabs days={days} onChange={setDays} />}
      {body}
    </div>
  );
}
