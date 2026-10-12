import { Link, useParams } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import {
  CourierRateCardRemoveMutation,
  CourierRateCardSetMutation,
  CourierRateCardsQuery,
} from '../api/operations';
import type {
  CourierRateCardRemoveData,
  CourierRateCardSetData,
  CourierRateCardsData,
  CourierRateCardValue,
} from '../api/types';
import { errorText } from '../i18n/errors';
import { useLocale } from '../i18n/locale';
import { problemText } from '../products/product-form';
import { useAdminMutation, useAdminQuery, useShop } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, Card, ErrorState, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';

/** The card's fields as typed: amounts in rupees, percents as numbers. */
interface Draft {
  originCity: string;
  localFirst: string;
  localEach: string;
  otherFirst: string;
  otherEach: string;
  codFeePercent: string;
  returnPercent: string;
}

const BLANK: Draft = {
  originCity: '',
  localFirst: '',
  localEach: '',
  otherFirst: '',
  otherEach: '',
  codFeePercent: '',
  returnPercent: '',
};

function draftOf(card: CourierRateCardValue): Draft {
  const amount = (value: { amount: string }) => String(Number(value.amount));
  return {
    originCity: card.originCity,
    localFirst: amount(card.localFirst),
    localEach: amount(card.localEach),
    otherFirst: amount(card.otherFirst),
    otherEach: amount(card.otherEach),
    codFeePercent: String(card.codFeePercent),
    returnPercent: String(card.returnPercent),
  };
}

/**
 * A courier account's rate card (SHP-07, ADR-383): what the courier charges by the half kilo
 * within the city the shop ships from and to other cities, its share of the cash it collects, and
 * of the charge again to bring a parcel back. Each parcel booked with the account from then on is
 * estimated by it, which profit counts until the courier's statement says what it charged.
 */
export function RateCardPage() {
  const { t } = useLocale();
  const shopId = useShop().id;
  const { accountId } = useParams({ from: '/$shopId/settings/couriers/$accountId/rates' });
  const query = useAdminQuery<CourierRateCardsData>(['courierRateCards'], CourierRateCardsQuery);
  const save = useAdminMutation<
    CourierRateCardSetData,
    { accountId: string; input: Record<string, string> }
  >(CourierRateCardSetMutation);
  const remove = useAdminMutation<CourierRateCardRemoveData, { accountId: string }>(
    CourierRateCardRemoveMutation,
  );
  const [draft, setDraft] = useState<Draft | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [said, setSaid] = useState('');

  const back = (
    <Link
      to="/$shopId/settings/couriers"
      params={{ shopId }}
      className="inline-flex min-h-10 items-center gap-1 self-start text-secondary hover:text-text"
    >
      <ArrowLeft aria-hidden className="size-5 rtl:rotate-180" />
      {t('settings.couriers')}
    </Link>
  );

  if (query.isPending) return <Loading label={t('state.loading')} />;
  if (query.isError) {
    return (
      <div className="mx-auto flex max-w-3xl flex-col gap-4 pb-8">
        {back}
        <ErrorState
          message={errorText(query.error, t)}
          action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
        />
      </div>
    );
  }
  const account = query.data.courierAccounts.find((each) => each.id === accountId);
  const card = query.data.courierRateCards.find((each) => each.accountId === accountId) ?? null;
  const editing = draft ?? (card ? draftOf(card) : BLANK);
  const field = (key: keyof Draft) => ({
    value: editing[key],
    onChange: (event: { target: { value: string } }) => {
      setDraft({ ...editing, [key]: event.target.value });
      setSaid('');
    },
  });

  const onSave = async (event: FormEvent) => {
    event.preventDefault();
    setProblems([]);
    setSaid('');
    try {
      const { courierRateCardSet: payload } = await save.mutateAsync({
        accountId,
        input: { ...editing },
      });
      if (payload.userErrors.length > 0) {
        setProblems(payload.userErrors.map((error) => problemText(error, t)));
        return;
      }
      setDraft(null);
      setSaid(t('rateCard.saved'));
    } catch (failure) {
      setProblems([errorText(failure, t)]);
    }
  };

  const onRemove = async () => {
    setProblems([]);
    setSaid('');
    try {
      const { courierRateCardRemove: payload } = await remove.mutateAsync({ accountId });
      if (payload.userErrors[0]) setProblems([problemText(payload.userErrors[0], t)]);
      else {
        setDraft(null);
        setSaid(t('rateCard.removed'));
      }
    } catch (failure) {
      setProblems([errorText(failure, t)]);
    }
  };

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 pb-8">
      {back}
      <h1 className="text-[length:var(--hatti-type-display-size)] font-semibold">
        {t('rateCard.title', { account: account?.name ?? '' })}
      </h1>
      <p className="text-secondary">{t('rateCard.hint')}</p>
      {said && <Alert tone="success">{said}</Alert>}
      {problems.length > 0 && (
        <Alert tone="danger">
          <ul className="list-disc ps-5">
            {problems.map((problem, index) => (
              <li key={index}>{problem}</li>
            ))}
          </ul>
        </Alert>
      )}
      <Card className="p-4">
        <form onSubmit={(event) => void onSave(event)} className="flex flex-col gap-4">
          <TextField
            label={t('rateCard.originCity')}
            hint={t('rateCard.originCityHint')}
            {...field('originCity')}
          />
          <fieldset className="grid gap-3 sm:grid-cols-2">
            <legend className="mb-2 font-semibold">{t('rateCard.local')}</legend>
            <TextField label={t('rateCard.first')} inputMode="decimal" {...field('localFirst')} />
            <TextField label={t('rateCard.each')} inputMode="decimal" {...field('localEach')} />
          </fieldset>
          <fieldset className="grid gap-3 sm:grid-cols-2">
            <legend className="mb-2 font-semibold">{t('rateCard.other')}</legend>
            <TextField label={t('rateCard.first')} inputMode="decimal" {...field('otherFirst')} />
            <TextField label={t('rateCard.each')} inputMode="decimal" {...field('otherEach')} />
          </fieldset>
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField
              label={t('rateCard.codFee')}
              hint={t('rateCard.codFeeHint')}
              inputMode="decimal"
              {...field('codFeePercent')}
            />
            <TextField
              label={t('rateCard.returnShare')}
              hint={t('rateCard.returnShareHint')}
              inputMode="decimal"
              {...field('returnPercent')}
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" busy={save.isPending}>
              {t('rateCard.save')}
            </Button>
            {card && (
              <Button variant="danger" busy={remove.isPending} onClick={() => void onRemove()}>
                {t('rateCard.remove')}
              </Button>
            )}
          </div>
        </form>
      </Card>
    </div>
  );
}
