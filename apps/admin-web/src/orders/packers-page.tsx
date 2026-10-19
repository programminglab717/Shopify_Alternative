import { Link } from '@tanstack/react-router';
import { ArrowLeft, Bot, UserRound } from 'lucide-react';
import { useMemo, useState } from 'react';
import { startOfDay } from '../analytics/period';
import { PackersQuery } from '../api/operations';
import type { PackerValue, PackersData } from '../api/types';
import { can, gate, hasCapability, permits } from '../auth/permissions';
import { errorText } from '../i18n/errors';
import { formatCount } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { useAdminQuery, useShop, useShopTimezone } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Card, EmptyState, ErrorState, Loading } from '../ui/feedback';

/** The roles that see every packer's counts: those who run the shop, as the core has it. */
export const SEES_PACKERS = gate(['owner', 'manager'], 'see_staff_performance');
/** The roles that see packing counts at all: packers see their own (ADR-376). */
export const SEES_PACKING = gate(
  [...SEES_PACKERS.roles, 'packer'],
  (shop) =>
    can(shop, 'read_orders') &&
    (shop.role === 'packer' || hasCapability(shop, 'see_staff_performance')),
);

/** The periods packing is counted over, in days: today, this week, this month. */
const PERIODS = [1, 7, 30] as const;
type Days = (typeof PERIODS)[number];

/** One of a packer's figures: what it counts, how many, and what goes with it. */
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

/**
 * A packer over the period: a member of staff by name, or as former staff once they have gone, or
 * as "you" to a packer seeing their own; an app, told apart by the end of its token. The orders
 * they packed, the items in them, and how many an hour.
 */
function Packer({ packer, name }: { packer: PackerValue; name: string }) {
  const { t } = useLocale();
  const app = packer.kind === 'APP';
  const Icon = app ? Bot : UserRound;
  return (
    <li>
      <Card className="flex flex-col gap-3 p-4">
        <h2 className="flex min-w-0 items-center gap-2 font-semibold">
          <Icon aria-hidden className="size-5 shrink-0 text-secondary" />
          <span className="truncate" dir="auto">
            {name}
          </span>
          {app && (
            <span dir="ltr" className="font-normal text-secondary">
              …{packer.id.slice(-6)}
            </span>
          )}
        </h2>
        <dl className="grid grid-cols-3 gap-3">
          <Stat label="packers.packed" value={formatCount(packer.packed)} />
          <Stat label="packers.units" value={formatCount(packer.units)} />
          <Stat
            label="packers.perHour"
            value={packer.packedPerHour === null ? '–' : packer.packedPerHour.toFixed(1)}
            hint={t('packers.hours', { count: packer.activeHours })}
          />
        </dl>
      </Card>
    </li>
  );
}

/**
 * How many orders each packer packed (APP-04, COD-11, ADR-376): today, over the last 7 or 30 days
 * in the shop's time zone, each member of staff or app with the orders they marked as packed that
 * nobody has unpacked since, the items in them, and how many an hour; those who packed most first,
 * as the core works it out. Owners and managers see everyone, with the total; packers their own.
 */
export function PackersPage() {
  const { t } = useLocale();
  const shop = useShop();
  const timezone = useShopTimezone();
  const allowed = permits(shop, SEES_PACKING);
  const managing = permits(shop, SEES_PACKERS);
  const [days, setDays] = useState<Days>(1);
  const period = useMemo(
    () => ({
      from: startOfDay(timezone, days - 1).toISOString(),
      before: startOfDay(timezone, -1).toISOString(),
    }),
    [days, timezone],
  );
  const query = useAdminQuery<PackersData>(
    ['packers'],
    PackersQuery,
    { ...period, managing },
    { enabled: allowed },
  );

  let body;
  if (!allowed) body = <EmptyState title={t('packers.cannot')} />;
  else if (query.isPending) body = <Loading label={t('state.loading')} />;
  else if (query.isError) {
    body = (
      <ErrorState
        message={errorText(query.error, t)}
        action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
      />
    );
  } else if (query.data.packers.length === 0) {
    body = <EmptyState title={t(managing ? 'packers.none' : 'packers.noneOwn')} />;
  } else {
    const { packers } = query.data;
    const names = new Map((query.data.staffMembers ?? []).map((each) => [each.id, each.name]));
    const nameOf = (packer: PackerValue) =>
      packer.kind === 'APP'
        ? t('activity.app')
        : managing
          ? (names.get(packer.id) ?? t('agents.former'))
          : t('packers.you');
    body = (
      <>
        {managing && packers.length > 1 && (
          <p className="font-medium">
            {t('packers.total', {
              count: formatCount(packers.reduce((sum, each) => sum + each.packed, 0)),
              units: formatCount(packers.reduce((sum, each) => sum + each.units, 0)),
            })}
          </p>
        )}
        <ul className="flex flex-col gap-3">
          {packers.map((packer) => (
            <Packer key={packer.id} packer={packer} name={nameOf(packer)} />
          ))}
        </ul>
      </>
    );
  }

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4 pb-8">
      <Link
        to="/$shopId/orders"
        params={{ shopId: shop.id }}
        search={{ stage: 'TO_PACK' }}
        className="inline-flex min-h-10 items-center gap-1 self-start text-secondary hover:text-text"
      >
        <ArrowLeft aria-hidden className="size-5 rtl:rotate-180" />
        {t('nav.orders')}
      </Link>
      <h1 className="text-[length:var(--hatti-type-display-size)] font-semibold">
        {t('packers.title')}
      </h1>
      <p className="text-secondary">{t(managing ? 'packers.hint' : 'packers.hintOwn')}</p>
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
