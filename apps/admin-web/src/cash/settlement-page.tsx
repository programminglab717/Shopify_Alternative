import { Link, useParams } from '@tanstack/react-router';
import type { OrderStage as BadgeColour } from '@hatti/tokens';
import type { LucideIcon } from 'lucide-react';
import { CircleAlert, CircleCheck, CircleHelp, FileText, Repeat, Undo2 } from 'lucide-react';
import { useState } from 'react';
import { PaymentSettlementQuery } from '../api/operations';
import type { MoneyValue, PaymentSettlementData, PaymentSettlementOutcome } from '../api/types';
import { errorText } from '../i18n/errors';
import { formatCount, formatDate, formatMoney } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { useAdminQuery, useShop, useShopTimezone } from '../shell/shop-context';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card, EmptyState, ErrorState, Loading } from '../ui/feedback';

/** How each outcome shows: matched in green, another amount in amber, no payment in red. */
const OUTCOME_BADGES: Record<PaymentSettlementOutcome, { colour: BadgeColour; icon: LucideIcon }> =
  {
    MATCHED: { colour: 'delivered', icon: CircleCheck },
    DIFFERS: { colour: 'needsConfirmation', icon: CircleAlert },
    UNMATCHED: { colour: 'deliveryIssue', icon: CircleHelp },
    REPEATED: { colour: 'cancelled', icon: Repeat },
    REFUND: { colour: 'confirmed', icon: Undo2 },
  };

/** Lines neither matched nor refunds, which staff look into. */
const SETTLED: readonly PaymentSettlementOutcome[] = ['MATCHED', 'REFUND'];

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
 * A gateway's settlement (PAY-07, ADR-491): what customers paid, the gateway's fees, the tax it
 * withheld and what it paid over; its lines, those to look into first, each with its payment's
 * order and what became of it.
 */
export function SettlementPage() {
  const { t, locale } = useLocale();
  const shopId = useShop().id;
  const timezone = useShopTimezone();
  const { settlementId } = useParams({ from: '/$shopId/settlements/$settlementId' });
  const [issuesOnly, setIssuesOnly] = useState<boolean | null>(null);
  const query = useAdminQuery<PaymentSettlementData>(
    ['paymentSettlement', settlementId],
    PaymentSettlementQuery,
    { id: settlementId },
  );
  const settlement = query.data?.paymentSettlement;

  if (query.isPending) return <Loading label={t('state.loading')} />;
  if (query.isError) {
    return (
      <ErrorState
        message={errorText(query.error, t)}
        action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
      />
    );
  }
  if (!settlement) {
    return (
      <Card>
        <EmptyState
          icon={<FileText aria-hidden className="size-8 text-secondary" />}
          title={t('settlements.missing')}
        />
      </Card>
    );
  }
  const showing = issuesOnly ?? settlement.issueCount > 0;
  const lines = showing
    ? settlement.lines.filter((line) => !SETTLED.includes(line.outcome))
    : settlement.lines;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 pb-8">
      <Link
        to="/$shopId/settlements"
        params={{ shopId }}
        className="inline-flex min-h-10 items-center self-start text-secondary hover:text-text"
      >
        {t('settlements.title')}
      </Link>
      <div className="flex flex-col gap-1">
        <h1 className="text-[length:var(--hatti-type-display-size)] font-semibold" dir="auto">
          {t('settlements.settlement.title', { gateway: settlement.gatewayName })}
        </h1>
        <p className="text-secondary">
          {formatDate(settlement.createdAt, timezone, locale)}
          {settlement.reference && (
            <>
              {' · '}
              <span dir="ltr">{settlement.reference}</span>
            </>
          )}
        </p>
      </div>
      <Card className="grid grid-cols-2 gap-3 p-4 md:grid-cols-4">
        <Amount label="settlements.gross" money={settlement.gross} />
        <Amount label="settlements.fees" money={settlement.fees} />
        <Amount label="cash.statement.tax" money={settlement.tax} />
        <Amount label="cash.statement.paid" money={settlement.net} />
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
              ? t('cash.statement.toLookInto', { count: formatCount(settlement.issueCount) })
              : t('cash.statement.allLines', { count: formatCount(settlement.lineCount) })}
          </button>
        ))}
      </div>
      {lines.length === 0 ? (
        <Card>
          <EmptyState
            icon={<CircleCheck aria-hidden className="size-8 text-success" />}
            title={t('settlements.nothingToLookInto')}
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
                    {line.transactionRef}
                  </span>
                  <Badge
                    colour={badge.colour}
                    icon={badge.icon}
                    label={t(`settlements.outcome.${line.outcome}` as MessageKey)}
                  />
                  <span className="flex basis-full flex-wrap gap-x-3 text-secondary text-[length:var(--hatti-type-body-sm-size)]">
                    {line.orderId ? (
                      <Link
                        to="/$shopId/orders/$orderId"
                        params={{ shopId, orderId: line.orderId }}
                        className="text-text underline"
                      >
                        {t('settlements.line.order')}
                      </Link>
                    ) : (
                      <span>{t('cash.statement.row', { row: line.row })}</span>
                    )}
                    <span>
                      {t('settlements.line', {
                        gross: formatMoney(line.gross.amount),
                        fees: formatMoney(line.fees.amount),
                        tax: formatMoney(line.tax.amount),
                      })}
                    </span>
                    {line.paid && line.outcome === 'DIFFERS' && (
                      <span>
                        {t('settlements.line.paid', { paid: formatMoney(line.paid.amount) })}
                      </span>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </div>
  );
}
