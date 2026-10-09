import { Link } from '@tanstack/react-router';
import { ChevronRight, CircleCheck, Circle, PartyPopper } from 'lucide-react';
import { ApiError } from '../api/client';
import { HomeQuery, SetupChecklistQuery } from '../api/operations';
import type { HomeData, OrderStage, SetupChecklistData, Tally } from '../api/types';
import type { StaffRole } from '../auth/session';
import { RECONCILES_CASH } from '../cash/cash-page';
import { errorText } from '../i18n/errors';
import { formatCount, formatMoney } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { CLAIMS } from '../returns/parcel';
import type { ReturnsTab } from '../returns/parcel';
import { useAdminQuery, useShop } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Card, EmptyState, ErrorState, Loading } from '../ui/feedback';

type HomeKey = Exclude<keyof HomeData['home'], 'today'>;

/** A page of its own that a next action opens, for the roles that use it. */
interface Opens {
  to: '/$shopId/returns' | '/$shopId/cash';
  tab?: ReturnsTab;
  roles: readonly StaffRole[];
}

/**
 * Home's next actions in the pipeline's order, each with the orders tab it opens, or the page of
 * its own for the roles that use it, if any.
 */
const NEXT: readonly { key: HomeKey; stage?: OrderStage; opens?: Opens }[] = [
  { key: 'toConfirm', stage: 'NEEDS_CONFIRMATION' },
  { key: 'toReview', stage: 'NEEDS_REVIEW' },
  { key: 'awaitingPayment', stage: 'AWAITING_PAYMENT' },
  { key: 'transfersToCheck' },
  { key: 'toPack', stage: 'TO_PACK' },
  { key: 'toBook', stage: 'TO_BOOK' },
  { key: 'returning', stage: 'RETURNING' },
  { key: 'returnsToReceive' },
  { key: 'cashToCollect', opens: { to: '/$shopId/cash', roles: RECONCILES_CASH } },
  { key: 'lostToClaim', opens: { to: '/$shopId/returns', tab: 'lost', roles: CLAIMS } },
  { key: 'claimsOpen', opens: { to: '/$shopId/returns', tab: 'claims', roles: CLAIMS } },
];

function NextAction({
  label,
  tally,
  stage,
  opens,
}: {
  label: string;
  tally: Tally;
  stage?: OrderStage;
  opens?: Opens;
}) {
  const { id: shopId, role } = useShop();
  const page = opens && opens.roles.includes(role) ? opens : undefined;
  const body = (
    <>
      <span className="flex flex-1 flex-col">
        <span className="font-medium">{label}</span>
        <span className="num text-secondary">
          {formatMoney(tally.total.amount, tally.total.currencyCode)}
        </span>
      </span>
      {(stage || page) && (
        <ChevronRight aria-hidden className="size-5 text-secondary rtl:rotate-180" />
      )}
    </>
  );
  return (
    <li>
      {stage ? (
        <Link
          to="/$shopId/orders"
          params={{ shopId }}
          search={{ stage }}
          className="flex min-h-14 items-center gap-3 px-4 py-2 hover:bg-canvas"
        >
          {body}
        </Link>
      ) : page?.to === '/$shopId/returns' ? (
        <Link
          to="/$shopId/returns"
          params={{ shopId }}
          search={page.tab ? { tab: page.tab } : {}}
          className="flex min-h-14 items-center gap-3 px-4 py-2 hover:bg-canvas"
        >
          {body}
        </Link>
      ) : page ? (
        <Link
          to={page.to}
          params={{ shopId }}
          className="flex min-h-14 items-center gap-3 px-4 py-2 hover:bg-canvas"
        >
          {body}
        </Link>
      ) : (
        <div className="flex min-h-14 items-center gap-3 px-4 py-2">{body}</div>
      )}
    </li>
  );
}

function Stat({
  label,
  tally,
  counted,
  note,
}: {
  label: string;
  tally: Tally;
  /** What the count is of: "13 orders", "1 parcel". */
  counted: 'home.orderCount' | 'home.parcelCount';
  note?: string;
}) {
  const { t } = useLocale();
  return (
    <div className="flex flex-col gap-1 rounded-card border border-line bg-surface p-4">
      <span className="text-secondary">{label}</span>
      <span className="num text-[length:var(--hatti-type-title-size)] font-semibold">
        {formatMoney(tally.total.amount, tally.total.currencyCode)}
      </span>
      <span className="text-secondary">{t(counted, { count: formatCount(tally.count) })}</span>
      {note && <span className="text-secondary">{note}</span>}
    </div>
  );
}

/** The setup checklist (ONB-02), for owners and managers until every step is done. */
function SetupChecklist() {
  const { t } = useLocale();
  const shop = useShop();
  const allowed = shop.role === 'owner' || shop.role === 'manager';
  const checklist = useAdminQuery<SetupChecklistData>(
    ['setupChecklist'],
    SetupChecklistQuery,
    {},
    {
      enabled: allowed,
    },
  );
  const data = checklist.data?.setupChecklist;
  if (!allowed || !data || data.done === data.total) return null;
  return (
    <Card className="p-4">
      <h2 className="font-semibold">{t('home.setup')}</h2>
      <p className="text-secondary">
        {t('home.setupProgress', { done: data.done, total: data.total })}
      </p>
      <ul className="mt-3 flex flex-col gap-2">
        {data.steps.map((step) => (
          <li key={step.key} className="flex items-center gap-2">
            {step.done ? (
              <CircleCheck aria-hidden className="size-5 text-success" />
            ) : (
              <Circle aria-hidden className="size-5 text-secondary" />
            )}
            <span className={step.done ? 'text-secondary line-through' : ''}>
              {t(`setup.${step.key}` as MessageKey)}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/**
 * Home (ANL-01, docs/design/02 §2): what needs the merchant now, each with its count and what it
 * comes to in rupees, a tap from its orders; how today has gone; and the setup checklist.
 */
export function HomePage() {
  const { t } = useLocale();
  const home = useAdminQuery<HomeData>(['home'], HomeQuery);

  if (home.isPending) return <Loading label={t('state.loading')} />;
  if (home.isError) {
    // A role that reads no orders has nothing here but the checklist.
    if (home.error instanceof ApiError && home.error.code === 'ACCESS_DENIED') {
      return <SetupChecklist />;
    }
    return (
      <ErrorState
        message={errorText(home.error, t)}
        action={<Button onClick={() => void home.refetch()}>{t('action.retry')}</Button>}
      />
    );
  }

  const { home: tallies } = home.data;
  const next = NEXT.filter(({ key }) => tallies[key].count > 0);
  const today = tallies.today;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <h1 className="text-[length:var(--hatti-type-display-size)] font-semibold">
        {t('home.title')}
      </h1>
      <SetupChecklist />
      <section aria-labelledby="home-next" className="flex flex-col gap-2">
        <h2 id="home-next" className="font-semibold">
          {t('home.next')}
        </h2>
        {next.length === 0 ? (
          <Card>
            <EmptyState
              icon={<PartyPopper aria-hidden className="size-8 text-primary" />}
              title={t('home.caughtUp')}
            />
          </Card>
        ) : (
          <Card>
            <ul className="divide-y divide-line">
              {next.map(({ key, stage, opens }) => (
                <NextAction
                  key={key}
                  label={t(`home.${key}` as MessageKey, { count: formatCount(tallies[key].count) })}
                  tally={tallies[key]}
                  stage={stage}
                  opens={opens}
                />
              ))}
            </ul>
          </Card>
        )}
      </section>
      <section aria-labelledby="home-today" className="flex flex-col gap-2">
        <h2 id="home-today" className="font-semibold">
          {t('home.today')}
        </h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Stat
            label={t('home.sales')}
            tally={today.sales}
            counted="home.orderCount"
            note={t('home.salesYesterday', {
              amount: formatMoney(
                today.salesYesterday.total.amount,
                today.salesYesterday.total.currencyCode,
              ),
            })}
          />
          <Stat label={t('home.delivered')} tally={today.delivered} counted="home.parcelCount" />
          <Stat
            label={t('home.returnedToOrigin')}
            tally={today.returnedToOrigin}
            counted="home.parcelCount"
          />
        </div>
      </section>
    </div>
  );
}
