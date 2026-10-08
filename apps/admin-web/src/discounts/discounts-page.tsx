import { CalendarClock, CircleCheck, Plus, Shuffle, Tag, TimerOff, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import {
  DiscountCodeCreateMutation,
  DiscountCodeDeleteMutation,
  DiscountCodesQuery,
  DiscountCodeUpdateMutation,
} from '../api/operations';
import type {
  DiscountCodeKind,
  DiscountCodePayloadData,
  DiscountCodesData,
  DiscountCodeValue,
  UserError,
} from '../api/types';
import type { StaffRole } from '../auth/session';
import { errorText } from '../i18n/errors';
import { formatDate } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { problemText } from '../products/product-form';
import { CheckField, Pair, Problems, SelectField, settingProblem } from '../settings/settings-form';
import { useAdminMutation, useAdminQuery, useShop, useShopTimezone } from '../shell/shop-context';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Alert, Card, EmptyState, ErrorState, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';

/** The roles that make and end discount codes (the core's write_discounts). */
export const MANAGES_DISCOUNTS: readonly StaffRole[] = ['owner', 'manager', 'marketer'];

const STATUS_BADGES = {
  ACTIVE: { colour: 'delivered', icon: CircleCheck },
  SCHEDULED: { colour: 'needsConfirmation', icon: CalendarClock },
  EXPIRED: { colour: 'cancelled', icon: TimerOff },
} as const;

/** A code that is easy to read out on a call: no 0/O or 1/I to mix up. */
export function newCode(random: () => number = Math.random): string {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 8 }, () => letters[Math.floor(random() * letters.length)]).join('');
}

/** The start of a day typed in a date field, or its end, as the browser's clock has it. */
function dayInput(date: string, end: boolean): string | null {
  if (!date) return null;
  return new Date(`${date}T${end ? '23:59:59' : '00:00:00'}`).toISOString();
}

const LABELS: Partial<Record<string, MessageKey>> = {
  code: 'discounts.code',
  percentage: 'discounts.percentage',
  amount: 'discounts.amount',
  minimumSubtotal: 'discounts.minimum',
  usageLimit: 'discounts.usageLimit',
  startsAt: 'discounts.starts',
  endsAt: 'discounts.ends',
};

function NewCodeForm({ onDone }: { onDone: (code: DiscountCodeValue) => void }) {
  const { t } = useLocale();
  const create = useAdminMutation<
    { discountCodeCreate: DiscountCodePayloadData },
    { discountCode: Record<string, unknown> }
  >(DiscountCodeCreateMutation);
  const [code, setCode] = useState('');
  const [kind, setKind] = useState<DiscountCodeKind>('PERCENTAGE');
  const [value, setValue] = useState('');
  const [minimum, setMinimum] = useState('');
  const [limit, setLimit] = useState('');
  const [once, setOnce] = useState(false);
  const [starts, setStarts] = useState('');
  const [ends, setEnds] = useState('');
  const [problems, setProblems] = useState<string[]>([]);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const usageLimit = limit.trim() ? Number(limit.replace(/,/g, '')) : null;
    if (usageLimit !== null && !Number.isInteger(usageLimit)) {
      setProblems([`${t('discounts.usageLimit')}: ${t('settings.badNumber')}`]);
      return;
    }
    setProblems([]);
    try {
      const { discountCodeCreate } = await create.mutateAsync({
        discountCode: {
          code: code.trim(),
          ...(kind === 'PERCENTAGE' && { percentage: Number(value.replace(/%$/, '').trim()) }),
          ...(kind === 'FIXED_AMOUNT' && { amount: value.trim() }),
          ...(kind === 'FREE_SHIPPING' && { freeShipping: true }),
          minimumSubtotal: minimum.trim() || null,
          usageLimit,
          oncePerCustomer: once,
          ...(starts && { startsAt: dayInput(starts, false) }),
          endsAt: dayInput(ends, true),
        },
      });
      if (discountCodeCreate.userErrors.length > 0 || !discountCodeCreate.discountCode) {
        setProblems(discountCodeCreate.userErrors.map((error) => settingProblem(error, t, LABELS)));
      } else onDone(discountCodeCreate.discountCode);
    } catch (failure) {
      setProblems([errorText(failure, t)]);
    }
  };

  return (
    <Card className="p-4">
      <form onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-4">
        <h2 className="font-semibold">{t('discounts.new')}</h2>
        <TextField
          label={t('discounts.code')}
          hint={t('discounts.codeHint')}
          required
          maxLength={64}
          autoCapitalize="characters"
          spellCheck={false}
          ltr
          value={code}
          onChange={(event) => setCode(event.target.value.toUpperCase())}
        />
        <Button
          variant="tertiary"
          className="-mt-2 self-start"
          icon={<Shuffle aria-hidden className="size-5" />}
          onClick={() => setCode(newCode())}
        >
          {t('discounts.makeOne')}
        </Button>
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
        <Pair>
          <TextField
            label={t('discounts.minimum')}
            hint={t('discounts.minimumHint')}
            inputMode="decimal"
            ltr
            value={minimum}
            onChange={(event) => setMinimum(event.target.value)}
          />
          <TextField
            label={t('discounts.usageLimit')}
            hint={t('discounts.usageLimitHint')}
            inputMode="numeric"
            ltr
            value={limit}
            onChange={(event) => setLimit(event.target.value)}
          />
        </Pair>
        <CheckField
          label={t('discounts.once')}
          hint={t('discounts.onceHint')}
          checked={once}
          onChange={setOnce}
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
          {t('discounts.create')}
        </Button>
      </form>
    </Card>
  );
}

function CodeRow({ code, edits }: { code: DiscountCodeValue; edits: boolean }) {
  const { t, locale } = useLocale();
  const timezone = useShopTimezone();
  const update = useAdminMutation<
    { discountCodeUpdate: { userErrors: UserError[] } },
    { id: string; discountCode: { endsAt: string } }
  >(DiscountCodeUpdateMutation);
  const remove = useAdminMutation<
    { discountCodeDelete: { userErrors: UserError[] } },
    { id: string }
  >(DiscountCodeDeleteMutation);
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
        <span className="num font-semibold" dir="ltr">
          {code.code}
        </span>
        {code.title !== code.code && (
          <span className="text-secondary" dir="auto">
            {code.title}
          </span>
        )}
        <span className="flex-1" />
        <Badge
          {...STATUS_BADGES[code.status]}
          label={t(`discounts.status.${code.status}` as MessageKey)}
        />
      </div>
      <p dir="auto">{code.summary}</p>
      <p className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
        {code.usageLimit === null
          ? t('discounts.used', { count: code.usageCount })
          : t('discounts.usedOf', { count: code.usageCount, limit: code.usageLimit })}
        {code.status === 'SCHEDULED' &&
          ` · ${t('discounts.startsOn', { date: formatDate(code.startsAt, timezone, locale) })}`}
        {code.status === 'ACTIVE' &&
          code.endsAt &&
          ` · ${t('discounts.endsOn', { date: formatDate(code.endsAt, timezone, locale) })}`}
      </p>
      {edits && (
        <div className="flex flex-wrap gap-2">
          {code.status !== 'EXPIRED' && (
            <Button
              variant="tertiary"
              icon={<TimerOff aria-hidden className="size-5" />}
              busy={update.isPending}
              onClick={() =>
                void run(
                  async () =>
                    (
                      await update.mutateAsync({
                        id: code.id,
                        discountCode: { endsAt: new Date().toISOString() },
                      })
                    ).discountCodeUpdate.userErrors,
                )
              }
            >
              {t('discounts.endNow')}
            </Button>
          )}
          {deleting ? (
            <>
              <span className="self-center">{t('discounts.deleteSure')}</span>
              <Button
                variant="destructive"
                busy={remove.isPending}
                onClick={() =>
                  void run(
                    async () =>
                      (await remove.mutateAsync({ id: code.id })).discountCodeDelete.userErrors,
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
 * Discount codes (CHK-06, ADR-062): each with what it gives in a line, whether it works now, and
 * how often it was used; made for a percentage, an amount or free delivery, limited and dated;
 * ended at once, or deleted. Owners, managers and marketers make them.
 */
export function DiscountsPage() {
  const { t } = useLocale();
  const { role } = useShop();
  const query = useAdminQuery<DiscountCodesData>(['discountCodes'], DiscountCodesQuery);
  const edits = MANAGES_DISCOUNTS.includes(role);
  const [making, setMaking] = useState(false);
  const [made, setMade] = useState<string | null>(null);

  if (query.isPending) return <Loading label={t('state.loading')} />;
  if (query.isError) {
    return (
      <ErrorState
        message={errorText(query.error, t)}
        action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
      />
    );
  }
  const codes = query.data.discountCodes.nodes;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 pb-8">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-[length:var(--hatti-type-display-size)] font-semibold">
          {t('discounts.title')}
        </h1>
        {edits && !making && (
          <Button
            icon={<Plus aria-hidden className="size-5" />}
            onClick={() => {
              setMaking(true);
              setMade(null);
            }}
          >
            {t('discounts.new')}
          </Button>
        )}
      </div>
      {made && <Alert tone="success">{t('discounts.made', { code: made })}</Alert>}
      {making && (
        <NewCodeForm
          onDone={(code) => {
            setMaking(false);
            setMade(code.code);
          }}
        />
      )}
      {codes.length === 0 ? (
        !making && (
          <Card>
            <EmptyState
              icon={<Tag aria-hidden className="size-8 text-secondary" />}
              title={t('discounts.none')}
              body={t('discounts.noneBody')}
            />
          </Card>
        )
      ) : (
        <Card>
          <ul className="divide-y divide-line">
            {codes.map((code) => (
              <CodeRow key={code.id} code={code} edits={edits} />
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
