import { Link, useParams } from '@tanstack/react-router';
import type { OrderStage as BadgeColour } from '@hatti/tokens';
import type { LucideIcon } from 'lucide-react';
import {
  CircleAlert,
  CircleCheck,
  CircleHelp,
  CircleMinus,
  FileText,
  HandCoins,
  Repeat,
  Truck,
} from 'lucide-react';
import { useState } from 'react';
import { CashStatementQuery } from '../api/operations';
import type { CashStatementData, CodRemittanceOutcome, MoneyValue } from '../api/types';
import { errorText } from '../i18n/errors';
import { formatCount, formatDate, formatMoney } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { useAdminQuery, useShop, useShopTimezone } from '../shell/shop-context';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card, EmptyState, ErrorState, Loading } from '../ui/feedback';

/** How each outcome shows: received in green, short or over in amber, no parcel in red. */
const OUTCOME_BADGES: Record<CodRemittanceOutcome, { colour: BadgeColour; icon: LucideIcon }> = {
  RECEIVED: { colour: 'delivered', icon: CircleCheck },
  SHORT: { colour: 'needsConfirmation', icon: CircleAlert },
  OVER: { colour: 'needsConfirmation', icon: CircleAlert },
  COMPENSATED: { colour: 'confirmed', icon: HandCoins },
  CHARGED: { colour: 'confirmed', icon: Truck },
  NOT_OWED: { colour: 'cancelled', icon: CircleMinus },
  REPEATED: { colour: 'cancelled', icon: Repeat },
  UNMATCHED: { colour: 'deliveryIssue', icon: CircleHelp },
};

/** The most lines a statement's page lists at once, as the core gives them. */
const MOST_LINES = 250;

function Amount({ label, money }: { label: MessageKey; money: MoneyValue }) {
  const { t } = useLocale();
  return (
    <div className="flex flex-col">
      <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
        {t(label)}
      </span>
      <span className="num font-semibold">{formatMoney(money.amount)}</span>
    </div>
  );
}

/**
 * A courier's statement (COD-10, ADR-067): what it collected, charged, withheld and paid over,
 * and what of it was received on orders; its lines, those to look into first, each with its
 * parcel's order and what became of it.
 */
export function StatementPage() {
  const { t, locale } = useLocale();
  const shopId = useShop().id;
  const timezone = useShopTimezone();
  const { remittanceId } = useParams({ from: '/$shopId/cash/$remittanceId' });
  const [issuesOnly, setIssuesOnly] = useState<boolean | null>(null);
  // The statement with its lines to look into; all its lines once asked, or where it has none.
  const first = useAdminQuery<CashStatementData>(
    ['codRemittance', remittanceId, true],
    CashStatementQuery,
    { id: remittanceId, issuesOnly: true },
  );
  const statement = first.data?.codRemittance;
  const showing = issuesOnly ?? (statement ? statement.issueCount > 0 : true);
  const all = useAdminQuery<CashStatementData>(
    ['codRemittance', remittanceId, false],
    CashStatementQuery,
    { id: remittanceId, issuesOnly: false },
    { enabled: !showing },
  );
  const lines = (showing ? first : all).data?.codRemittance?.lines;

  if (first.isPending) return <Loading label={t('state.loading')} />;
  if (first.isError) {
    return (
      <ErrorState
        message={errorText(first.error, t)}
        action={<Button onClick={() => void first.refetch()}>{t('action.retry')}</Button>}
      />
    );
  }
  if (!statement) {
    return (
      <Card>
        <EmptyState
          icon={<FileText aria-hidden className="size-8 text-secondary" />}
          title={t('cash.statement.missing')}
        />
      </Card>
    );
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 pb-8">
      <Link
        to="/$shopId/cash"
        params={{ shopId }}
        className="inline-flex min-h-10 items-center self-start text-secondary hover:text-text"
      >
        {t('cash.title')}
      </Link>
      <div className="flex flex-col gap-1">
        <h1 className="text-[length:var(--hatti-type-display-size)] font-semibold" dir="auto">
          {t('cash.statement.title', { courier: statement.courier })}
        </h1>
        <p className="text-secondary">
          {formatDate(statement.createdAt, timezone, locale)}
          {statement.reference && (
            <>
              {' · '}
              <span dir="ltr">{statement.reference}</span>
            </>
          )}
        </p>
      </div>
      <Card className="grid grid-cols-2 gap-3 p-4 md:grid-cols-3">
        <Amount label="cash.statement.collected" money={statement.collected} />
        <Amount label="cash.statement.charges" money={statement.charges} />
        <Amount label="cash.statement.tax" money={statement.tax} />
        <Amount label="cash.statement.paid" money={statement.paid} />
        <Amount label="cash.statement.received" money={statement.received} />
        {Number(statement.compensated.amount) > 0 && (
          <Amount label="cash.statement.compensated" money={statement.compensated} />
        )}
      </Card>
      <div role="tablist" className="flex flex-wrap gap-2">
        {([true, false] as const).map((each) => (
          <button
            key={String(each)}
            type="button"
            role="tab"
            aria-selected={showing === each}
            onClick={() => setIssuesOnly(each)}
            className={`min-h-10 rounded-full border px-4 ${
              showing === each ? 'border-primary bg-primary text-on-primary' : 'border-line'
            }`}
          >
            {each
              ? t('cash.statement.toLookInto', { count: formatCount(statement.issueCount) })
              : t('cash.statement.allLines', { count: formatCount(statement.lineCount) })}
          </button>
        ))}
      </div>
      {!lines ? (
        <Loading label={t('state.loading')} />
      ) : lines.length === 0 ? (
        <Card>
          <EmptyState
            icon={<CircleCheck aria-hidden className="size-8 text-success" />}
            title={t('cash.statement.nothingToLookInto')}
          />
        </Card>
      ) : (
        <Card>
          <ul className="divide-y divide-line">
            {lines.map((line) => {
              const badge = OUTCOME_BADGES[line.outcome];
              return (
                <li
                  key={line.row}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3"
                >
                  <span className="num min-w-0 flex-1 font-medium" dir="ltr">
                    {line.trackingNumber}
                  </span>
                  <Badge
                    colour={badge.colour}
                    icon={badge.icon}
                    label={t(`cash.outcome.${line.outcome}` as MessageKey)}
                  />
                  <span className="flex basis-full flex-wrap gap-x-3 text-secondary text-[length:var(--hatti-type-body-sm-size)]">
                    {line.orderId && line.orderName ? (
                      <Link
                        to="/$shopId/orders/$orderId"
                        params={{ shopId, orderId: line.orderId }}
                        className="num text-text underline"
                      >
                        {line.orderName}
                      </Link>
                    ) : (
                      <span>{t('cash.statement.row', { row: line.row })}</span>
                    )}
                    <span>
                      {t('cash.statement.line', {
                        collected: formatMoney(line.collected.amount),
                        received: formatMoney(line.received.amount),
                      })}
                    </span>
                    {line.owed && (
                      <span>
                        {t('cash.statement.owed', { owed: formatMoney(line.owed.amount) })}
                      </span>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
      {lines && !showing && statement.lineCount > MOST_LINES && (
        <p className="text-secondary">
          {t('cash.statement.first', { count: formatCount(MOST_LINES) })}
        </p>
      )}
    </div>
  );
}
