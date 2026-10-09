import { Link } from '@tanstack/react-router';
import { Minus, Plus } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import {
  CustomerStoreCreditLedgerQuery,
  CustomerStoreCreditQuery,
  StoreCreditCreditMutation,
  StoreCreditDebitMutation,
} from '../api/operations';
import type {
  CustomerStoreCreditData,
  StoreCreditMoveData,
  StoreCreditTransaction,
} from '../api/types';
import type { StaffRole } from '../auth/session';
import { errorText } from '../i18n/errors';
import { endOfDayIn, formatDate, formatMoney } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { FormSection, parsePrice } from '../products/product-form';
import { useAttempt } from '../returns/parcel';
import { useAdminMutation, useAdminQuery, useShop, useShopDetails } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert } from '../ui/feedback';
import { TextField } from '../ui/field';

/** Those who see what a customer's store credit holds (ORD-09), as the core lets them read it. */
export const READS_CREDIT: readonly StaffRole[] = [
  'owner',
  'manager',
  'confirmation_agent',
  'accountant',
];

/** Those who read its ledger: what was given, spent and taken back. */
const READS_LEDGER: readonly StaffRole[] = ['owner', 'manager', 'accountant'];

/** Those who give credit and take it back by hand: owners and managers. */
export const MOVES_CREDIT: readonly StaffRole[] = ['owner', 'manager'];

const cents = (amount: string) => Math.round(Number(amount) * 100);

/** What a ledger line was, in words: given by hand, a refund, an order paid or given back. */
function whatOf(line: StoreCreditTransaction): MessageKey {
  if (line.kind === 'EXPIRATION') return 'credit.line.EXPIRATION';
  return `credit.line.${line.kind}.${line.event ?? 'ADJUSTMENT'}` as MessageKey;
}

/** Credit given or taken back by hand, with a note for the shop's records. */
function MoveForm({
  customerId,
  way,
  currencyCode,
  timezone,
  most,
  onDone,
}: {
  customerId: string;
  way: 'give' | 'take';
  currencyCode: string;
  timezone: string;
  most: string;
  onDone: (message: string) => void;
}) {
  const { t } = useLocale();
  const move = useAdminMutation<StoreCreditMoveData, Record<string, unknown>>(
    way === 'give' ? StoreCreditCreditMutation : StoreCreditDebitMutation,
  );
  const { problem, attempt } = useAttempt();
  const [amount, setAmount] = useState('');
  const [expires, setExpires] = useState('');
  const [note, setNote] = useState('');
  const parsed = parsePrice(amount);
  const tooMuch = way === 'take' && parsed !== null && cents(parsed) > cents(most);
  const ready = parsed !== null && cents(parsed) > 0 && !tooMuch;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    const money = { amount: parsed, currencyCode };
    const ok = await attempt(async () => {
      const data = await move.mutateAsync(
        way === 'give'
          ? {
              id: customerId,
              creditInput: {
                creditAmount: money,
                // The credit lasts to the end of the day chosen, in the shop's time zone.
                ...(expires && { expiresAt: endOfDayIn(expires, timezone) }),
                ...(note.trim() && { note: note.trim() }),
              },
            }
          : {
              id: customerId,
              debitInput: { debitAmount: money, ...(note.trim() && { note: note.trim() }) },
            },
      );
      return Object.values(data)[0]!;
    });
    if (ok) {
      onDone(t(way === 'give' ? 'credit.given' : 'credit.taken', { amount: formatMoney(parsed!) }));
    }
  };

  return (
    <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-3">
      <TextField
        label={
          way === 'give'
            ? t('credit.giveAmount')
            : t('credit.takeAmount', { most: formatMoney(most) })
        }
        inputMode="decimal"
        ltr
        value={amount}
        error={
          amount && parsed === null
            ? t('returns.claim.amountWrong')
            : tooMuch
              ? t('credit.tooMuch')
              : null
        }
        onChange={(event) => setAmount(event.target.value)}
      />
      {way === 'give' && (
        <TextField
          label={t('credit.expires')}
          hint={t('credit.expiresHint')}
          type="date"
          ltr
          value={expires}
          onChange={(event) => setExpires(event.target.value)}
        />
      )}
      <TextField
        label={t('credit.note')}
        hint={t('credit.noteHint')}
        dir="auto"
        value={note}
        onChange={(event) => setNote(event.target.value)}
      />
      {problem && <Alert tone="danger">{problem}</Alert>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" busy={move.isPending} disabled={!ready}>
          {way === 'give' ? t('credit.giveConfirm') : t('credit.takeConfirm')}
        </Button>
        <Button variant="tertiary" onClick={() => onDone('')}>
          {t('returns.cancel')}
        </Button>
      </div>
    </form>
  );
}

/** The ledger's lines, the newest first: what each did, when, and what was left after it. */
function Ledger({ lines, timezone }: { lines: StoreCreditTransaction[]; timezone: string }) {
  const { t, locale } = useLocale();
  const shopId = useShop().id;
  if (lines.length === 0) return null;
  return (
    <ul aria-label={t('credit.ledger')} className="flex flex-col divide-y divide-line">
      {lines.map((line) => (
        <li key={line.id} className="flex flex-col gap-0.5 py-2">
          <span className="flex flex-wrap justify-between gap-x-3">
            <span className="font-medium">{t(whatOf(line))}</span>
            <span className="num">
              {cents(line.amount.amount) > 0 && '+'}
              {formatMoney(line.amount.amount)}
            </span>
          </span>
          <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
            {formatDate(line.createdAt, timezone, locale)}
            {' · '}
            {t('credit.after', { amount: formatMoney(line.balanceAfterTransaction.amount) })}
            {line.kind === 'CREDIT' && line.expiresAt && (
              <>
                {' · '}
                {t('credit.expiresOn', { date: formatDate(line.expiresAt, timezone, locale) })}
              </>
            )}
            {line.note && (
              <>
                {' · '}
                <span dir="auto">{line.note}</span>
              </>
            )}
          </span>
          {line.orderId && (
            <Link
              to="/$shopId/orders/$orderId"
              params={{ shopId, orderId: line.orderId }}
              className="self-start text-primary underline"
            >
              {t('credit.order')}
            </Link>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * A customer's store credit (ORD-09, ADR-184): what it holds, and for those who keep it, its
 * ledger; owners and managers give credit by hand, with an expiry if they like, and take it back.
 */
export function StoreCredit({ customerId }: { customerId: string }) {
  const { t } = useLocale();
  const { role } = useShop();
  const shop = useShopDetails();
  const ledger = READS_LEDGER.includes(role);
  const query = useAdminQuery<CustomerStoreCreditData>(
    ['customerStoreCredit', customerId, ledger],
    ledger ? CustomerStoreCreditLedgerQuery : CustomerStoreCreditQuery,
    { id: customerId },
  );
  const [open, setOpen] = useState<'give' | 'take' | null>(null);
  const [done, setDone] = useState('');

  const accounts = query.data?.customer?.storeCreditAccounts.nodes ?? [];
  const currencyCode = accounts[0]?.balance.currencyCode ?? shop?.currencyCode ?? 'PKR';
  const balance =
    accounts.find((each) => each.balance.currencyCode === currencyCode)?.balance.amount ?? '0.00';
  const lines = accounts.flatMap((each) => each.transactions?.nodes ?? []);
  const moves = MOVES_CREDIT.includes(role);
  const timezone = shop?.timezone ?? 'Asia/Karachi';

  return (
    <FormSection title={t('credit.title')} hint={t('credit.hint')}>
      {query.isError && <Alert tone="danger">{errorText(query.error, t)}</Alert>}
      {query.data && (
        <p className="flex items-baseline justify-between gap-3">
          <span className="text-secondary">{t('credit.balance')}</span>
          <span className="num text-[length:var(--hatti-type-title-size)] font-semibold">
            {formatMoney(balance, currencyCode)}
          </span>
        </p>
      )}
      {done && <Alert tone="success">{done}</Alert>}
      {moves && open && (
        <MoveForm
          customerId={customerId}
          way={open}
          currencyCode={currencyCode}
          timezone={timezone}
          most={balance}
          onDone={(message) => {
            setOpen(null);
            setDone(message);
          }}
        />
      )}
      {moves && !open && query.data && (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            icon={<Plus aria-hidden className="size-5" />}
            onClick={() => {
              setDone('');
              setOpen('give');
            }}
          >
            {t('credit.give')}
          </Button>
          {cents(balance) > 0 && (
            <Button
              variant="secondary"
              icon={<Minus aria-hidden className="size-5" />}
              onClick={() => {
                setDone('');
                setOpen('take');
              }}
            >
              {t('credit.take')}
            </Button>
          )}
        </div>
      )}
      {ledger && <Ledger lines={lines} timezone={timezone} />}
    </FormSection>
  );
}
