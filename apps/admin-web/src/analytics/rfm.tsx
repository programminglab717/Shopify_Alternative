/**
 * Customers by how recently and how often they buy (ANL-04, ADR-887): RFM on a grid of three by
 * three, each group with how many, what they spent, and a way to save it as a segment to send a
 * campaign to.
 */
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { CustomerRfmQuery, SegmentCreateMutation } from '../api/operations';
import type { CustomerRfmData, RfmGroupValue, SegmentMutationData } from '../api/types';
import { permits } from '../auth/permissions';
import { KEEPS_SEGMENTS } from '../customers/customers-page';
import { errorText } from '../i18n/errors';
import { formatCount, formatMoney } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { useAdminMutation, useAdminQuery, useShop } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, Card, ErrorState, Loading } from '../ui/feedback';

/** Where the grid's lines may be drawn: recent within, and lapsed after, so many days. */
export const RFM_LINES = [
  { recentDays: 30, lapsedDays: 90 },
  { recentDays: 60, lapsedDays: 180 },
  { recentDays: 90, lapsedDays: 365 },
] as const;

/** A group's cell, and saving it as a segment for those who keep segments. */
function Group({ group, total }: { group: RfmGroupValue; total: number }) {
  const { t } = useLocale();
  const shop = useShop();
  const navigate = useNavigate();
  const [problem, setProblem] = useState<string | null>(null);
  const saving = useAdminMutation<SegmentMutationData, { name: string; query: string }>(
    SegmentCreateMutation,
  );
  const name = t(`rfm.group.${group.name}` as MessageKey);

  const save = async () => {
    setProblem(null);
    try {
      const { segmentCreate } = await saving.mutateAsync({ name, query: group.query });
      const error = segmentCreate?.userErrors[0];
      if (error || !segmentCreate?.segment) {
        setProblem(error?.message ?? t('state.error'));
        return;
      }
      void navigate({
        to: '/$shopId/customers/segments/$segmentId',
        params: { shopId: shop.id, segmentId: segmentCreate.segment.id },
      });
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  return (
    <li className="flex flex-col gap-1 rounded-control border border-line p-3">
      <span className="font-medium">{name}</span>
      <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
        {t(`rfm.hint.${group.name}` as MessageKey)}
      </span>
      <span className="num text-[length:var(--hatti-type-title-size)] font-semibold">
        {formatCount(group.customers)}
        <span className="ms-2 text-secondary text-[length:var(--hatti-type-body-sm-size)] font-normal">
          {total ? `${Math.round((group.customers / total) * 100)}%` : '–'}
        </span>
      </span>
      {group.customers > 0 && (
        <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
          {t('rfm.spent', { amount: formatMoney(group.amountSpent.amount) })}
        </span>
      )}
      {group.customers > 0 && permits(shop, KEEPS_SEGMENTS) && (
        <Button
          variant="secondary"
          className="mt-1 self-start"
          busy={saving.isPending}
          aria-label={t('rfm.saveNamed', { name })}
          onClick={() => void save()}
        >
          {t('rfm.save')}
        </Button>
      )}
      {problem && <Alert tone="danger">{problem}</Alert>}
    </li>
  );
}

export function Rfm() {
  const { t } = useLocale();
  const [lines, setLines] = useState(0);
  const query = useAdminQuery<CustomerRfmData>(['customerRfm'], CustomerRfmQuery, {
    ...RFM_LINES[lines]!,
  });

  let body;
  if (query.isPending) body = <Loading label={t('state.loading')} />;
  else if (query.isError) {
    body = (
      <ErrorState
        message={errorText(query.error, t)}
        action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
      />
    );
  } else {
    // Absent where an older core, or a fake one, leaves it out.
    const rfm = query.data.customerRfm as CustomerRfmData['customerRfm'] | undefined;
    body =
      !rfm || rfm.customers === 0 ? (
        <Card>
          <p className="p-4 text-secondary">{t('cohorts.none')}</p>
        </Card>
      ) : (
        <ul className="grid gap-2 sm:grid-cols-3">
          {rfm.groups.map((group) => (
            <Group key={group.name} group={group} total={rfm.customers} />
          ))}
        </ul>
      );
  }

  return (
    <section aria-labelledby="analytics-rfm" className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 id="analytics-rfm" className="font-semibold">
          {t('rfm.title')}
        </h2>
        <p className="text-secondary">{t('rfm.hint')}</p>
      </div>
      <div role="tablist" aria-label={t('rfm.lines')} className="flex flex-wrap gap-2">
        {RFM_LINES.map((each, index) => (
          <button
            key={each.recentDays}
            type="button"
            role="tab"
            aria-selected={lines === index}
            onClick={() => setLines(index)}
            className={`min-h-10 rounded-full border px-4 ${
              lines === index ? 'border-primary bg-primary text-on-primary' : 'border-line'
            }`}
          >
            {t('rfm.linesAt', each)}
          </button>
        ))}
      </div>
      {body}
    </section>
  );
}
