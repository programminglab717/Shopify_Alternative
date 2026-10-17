import { CalendarClock, CircleCheck, Plus, Sparkles, TimerOff, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import {
  AutomaticDiscountCreateMutation,
  AutomaticDiscountDeleteMutation,
  AutomaticDiscountsQuery,
  AutomaticDiscountUpdateMutation,
} from '../api/operations';
import type {
  AutomaticDiscountPayloadData,
  AutomaticDiscountsData,
  AutomaticDiscountValue,
  DiscountCodeKind,
  UserError,
} from '../api/types';
import { errorText } from '../i18n/errors';
import { endOfDayIn, formatDate, startOfDayIn } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { problemText } from '../products/product-form';
import { CheckField, Pair, Problems, SelectField, settingProblem } from '../settings/settings-form';
import { useAdminMutation, useAdminQuery, useShopTimezone } from '../shell/shop-context';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Alert, Card, ErrorState, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';

const STATUS_BADGES = {
  ACTIVE: { colour: 'delivered', icon: CircleCheck },
  SCHEDULED: { colour: 'needsConfirmation', icon: CalendarClock },
  EXPIRED: { colour: 'cancelled', icon: TimerOff },
} as const;

const LABELS: Partial<Record<string, MessageKey>> = {
  title: 'automatic.name',
  percentage: 'discounts.percentage',
  amount: 'discounts.amount',
  minimumSubtotal: 'discounts.minimum',
  startsAt: 'discounts.starts',
  endsAt: 'discounts.ends',
};

/** The start of a day typed in a date field, or its end, in the shop's time zone. */
function dayInput(date: string, end: boolean, timeZone: string): string | null {
  if (!date) return null;
  return end ? endOfDayIn(date, timeZone) : startOfDayIn(date, timeZone);
}

function NewAutomaticForm({ onDone }: { onDone: (discount: AutomaticDiscountValue) => void }) {
  const { t } = useLocale();
  const timezone = useShopTimezone();
  const create = useAdminMutation<
    { automaticDiscountCreate: AutomaticDiscountPayloadData },
    { automaticDiscount: Record<string, unknown> }
  >(AutomaticDiscountCreateMutation);
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<DiscountCodeKind>('PERCENTAGE');
  const [value, setValue] = useState('');
  const [minimum, setMinimum] = useState('');
  const [combines, setCombines] = useState(false);
  const [starts, setStarts] = useState('');
  const [ends, setEnds] = useState('');
  const [problems, setProblems] = useState<string[]>([]);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setProblems([]);
    try {
      const { automaticDiscountCreate } = await create.mutateAsync({
        automaticDiscount: {
          title: title.trim(),
          ...(kind === 'PERCENTAGE' && { percentage: Number(value.replace(/%$/, '').trim()) }),
          ...(kind === 'FIXED_AMOUNT' && { amount: value.trim() }),
          ...(kind === 'FREE_SHIPPING' && { freeShipping: true }),
          minimumSubtotal: minimum.trim() || null,
          combinesWithCodes: combines,
          ...(starts && { startsAt: dayInput(starts, false, timezone) }),
          endsAt: dayInput(ends, true, timezone),
        },
      });
      if (
        automaticDiscountCreate.userErrors.length > 0 ||
        !automaticDiscountCreate.automaticDiscount
      ) {
        setProblems(
          automaticDiscountCreate.userErrors.map((error) => settingProblem(error, t, LABELS)),
        );
      } else onDone(automaticDiscountCreate.automaticDiscount);
    } catch (failure) {
      setProblems([errorText(failure, t)]);
    }
  };

  return (
    <Card className="p-4">
      <form onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-4">
        <h3 className="font-semibold">{t('automatic.new')}</h3>
        <TextField
          label={t('automatic.name')}
          hint={t('automatic.nameHint')}
          required
          maxLength={255}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
        <Pair>
          <SelectField
            label={t('discounts.gives')}
            value={kind}
            options={[
              { value: 'PERCENTAGE', label: t('discounts.kind.PERCENTAGE') },
              { value: 'FIXED_AMOUNT', label: t('discounts.kind.FIXED_AMOUNT') },
              { value: 'FREE_SHIPPING', label: t('discounts.kind.FREE_SHIPPING') },
            ]}
            onChange={(next) => {
              setKind(next);
              setValue('');
            }}
          />
          {kind !== 'FREE_SHIPPING' && (
            <TextField
              label={t(kind === 'PERCENTAGE' ? 'discounts.percentage' : 'discounts.amount')}
              required
              inputMode="decimal"
              ltr
              value={value}
              onChange={(event) => setValue(event.target.value)}
            />
          )}
        </Pair>
        <TextField
          label={t('discounts.minimum')}
          hint={t('discounts.minimumHint')}
          inputMode="decimal"
          ltr
          value={minimum}
          onChange={(event) => setMinimum(event.target.value)}
        />
        <CheckField
          label={t('automatic.combines')}
          hint={t('automatic.combinesHint')}
          checked={combines}
          onChange={setCombines}
        />
        <Pair>
          <TextField
            label={t('discounts.starts')}
            hint={t('discounts.startsHint')}
            type="date"
            ltr
            value={starts}
            onChange={(event) => setStarts(event.target.value)}
          />
          <TextField
            label={t('discounts.ends')}
            hint={t('discounts.endsHint')}
            type="date"
            ltr
            value={ends}
            onChange={(event) => setEnds(event.target.value)}
          />
        </Pair>
        <Problems problems={problems} />
        <Button type="submit" busy={create.isPending} className="self-start">
          {t('automatic.create')}
        </Button>
      </form>
    </Card>
  );
}

function AutomaticRow({ discount, edits }: { discount: AutomaticDiscountValue; edits: boolean }) {
  const { t, locale } = useLocale();
  const timezone = useShopTimezone();
  const update = useAdminMutation<
    { automaticDiscountUpdate: { userErrors: UserError[] } },
    { id: string; automaticDiscount: { endsAt: string } }
  >(AutomaticDiscountUpdateMutation);
  const remove = useAdminMutation<
    { automaticDiscountDelete: { userErrors: UserError[] } },
    { id: string }
  >(AutomaticDiscountDeleteMutation);
  const [deleting, setDeleting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const run = async (action: () => Promise<UserError[]>) => {
    setProblem(null);
    try {
      const error = (await action())[0];
      if (error) setProblem(problemText(error, t));
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  return (
    <li className="flex flex-col gap-2 px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-semibold" dir="auto">
          {discount.title}
        </span>
        <span className="flex-1" />
        <Badge
          {...STATUS_BADGES[discount.status]}
          label={t(`discounts.status.${discount.status}` as MessageKey)}
        />
      </div>
      <p dir="auto">{discount.summary}</p>
      {(discount.status === 'SCHEDULED' || (discount.status === 'ACTIVE' && discount.endsAt)) && (
        <p className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
          {discount.status === 'SCHEDULED'
            ? t('discounts.startsOn', { date: formatDate(discount.startsAt, timezone, locale) })
            : t('discounts.endsOn', { date: formatDate(discount.endsAt!, timezone, locale) })}
        </p>
      )}
      {edits && (
        <div className="flex flex-wrap gap-2">
          {discount.status !== 'EXPIRED' && (
            <Button
              variant="tertiary"
              icon={<TimerOff aria-hidden className="size-5" />}
              busy={update.isPending}
              onClick={() =>
                void run(
                  async () =>
                    (
                      await update.mutateAsync({
                        id: discount.id,
                        automaticDiscount: { endsAt: new Date().toISOString() },
                      })
                    ).automaticDiscountUpdate.userErrors,
                )
              }
            >
              {t('discounts.endNow')}
            </Button>
          )}
          {deleting ? (
            <>
              <span className="self-center">{t('automatic.deleteSure')}</span>
              <Button
                variant="destructive"
                busy={remove.isPending}
                onClick={() =>
                  void run(
                    async () =>
                      (await remove.mutateAsync({ id: discount.id })).automaticDiscountDelete
                        .userErrors,
                  )
                }
              >
                {t('discounts.deleteYes')}
              </Button>
              <Button variant="tertiary" onClick={() => setDeleting(false)}>
                {t('action.back')}
              </Button>
            </>
          ) : (
            <Button
              variant="danger"
              icon={<Trash2 aria-hidden className="size-5" />}
              onClick={() => setDeleting(true)}
            >
              {t('discounts.delete')}
            </Button>
          )}
        </div>
      )}
      {problem && <Alert tone="danger">{problem}</Alert>}
    </li>
  );
}

/**
 * The shop's automatic discounts (CHK-06, ADR-515), on the discounts page beside its codes: each
 * with what it gives in a line and whether it runs; made for a percentage, an amount or free
 * delivery, with a minimum, dates and whether codes go with it; ended at once, or deleted.
 */
export function AutomaticDiscounts({ edits }: { edits: boolean }) {
  const { t } = useLocale();
  const query = useAdminQuery<AutomaticDiscountsData>(
    ['automaticDiscounts'],
    AutomaticDiscountsQuery,
  );
  const [making, setMaking] = useState(false);
  const [made, setMade] = useState<string | null>(null);

  return (
    <section className="flex flex-col gap-3" aria-labelledby="automatic-title">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="automatic-title" className="flex items-center gap-2 text-lg font-semibold">
          <Sparkles aria-hidden className="size-5 text-secondary" />
          {t('automatic.title')}
        </h2>
        {edits && !making && (
          <Button
            variant="secondary"
            icon={<Plus aria-hidden className="size-5" />}
            onClick={() => {
              setMaking(true);
              setMade(null);
            }}
          >
            {t('automatic.new')}
          </Button>
        )}
      </div>
      <p className="text-secondary">{t('automatic.intro')}</p>
      {made && <Alert tone="success">{t('automatic.made', { title: made })}</Alert>}
      {making && (
        <NewAutomaticForm
          onDone={(discount) => {
            setMaking(false);
            setMade(discount.title);
          }}
        />
      )}
      {query.isPending ? (
        <Loading label={t('state.loading')} />
      ) : query.isError ? (
        <ErrorState
          message={errorText(query.error, t)}
          action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
        />
      ) : query.data.automaticDiscounts.length === 0 ? (
        !making && <p className="text-secondary">{t('automatic.none')}</p>
      ) : (
        <Card>
          <ul className="divide-y divide-line">
            {query.data.automaticDiscounts.map((discount) => (
              <AutomaticRow key={discount.id} discount={discount} edits={edits} />
            ))}
          </ul>
        </Card>
      )}
    </section>
  );
}
