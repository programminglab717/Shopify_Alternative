import {
  Ban,
  CircleCheck,
  CircleOff,
  Clock,
  Copy,
  Gift,
  Minus,
  Pencil,
  Plus,
  Search,
  type LucideIcon,
} from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import type { OrderStage } from '@hatti/tokens';
import {
  CustomersQuery,
  GiftCardCreateMutation,
  GiftCardCreditMutation,
  GiftCardDeactivateMutation,
  GiftCardDebitMutation,
  GiftCardsQuery,
  GiftCardUpdateMutation,
} from '../api/operations';
import type {
  CustomersData,
  GiftCard,
  GiftCardCreateData,
  GiftCardCreateInput,
  GiftCardPayloadData,
  GiftCardsData,
  GiftCardUpdateInput,
} from '../api/types';
import { can, gate, permits } from '../auth/permissions';
import { errorText } from '../i18n/errors';
import { formatDate, formatMoney } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { useAttempt } from '../returns/parcel';
import { useAdminMutation, useAdminQuery, useShop, useShopTimezone } from '../shell/shop-context';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Alert, Card, EmptyState, ErrorState, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';
import { FormSection, parsePrice } from './product-form';

/** Those who look gift cards up, as the core lets them read them (ADR-448). */
export const READS_GIFT_CARDS = gate(
  ['owner', 'manager', 'accountant', 'confirmation_agent'],
  'read_gift_cards',
);

/** Those who issue, change and deactivate them: owners and managers. */
const EDITS_GIFT_CARDS = gate(['owner', 'manager'], 'write_gift_cards');

type CardState = 'ACTIVE' | 'USED_UP' | 'EXPIRED' | 'DEACTIVATED';

const STATE: Record<CardState, { colour: OrderStage; icon: LucideIcon }> = {
  ACTIVE: { colour: 'delivered', icon: CircleCheck },
  USED_UP: { colour: 'returned', icon: CircleOff },
  EXPIRED: { colour: 'cancelled', icon: Clock },
  DEACTIVATED: { colour: 'cancelled', icon: Ban },
};

function stateOf(card: GiftCard): CardState {
  if (!card.enabled) return 'DEACTIVATED';
  if (card.expired) return 'EXPIRED';
  if (Number(card.balance.amount) === 0) return 'USED_UP';
  return 'ACTIVE';
}

/** A card to issue: what it is worth, the shop's own code or one made, its last day and a note. */
function IssueCard() {
  const { t } = useLocale();
  const create = useAdminMutation<GiftCardCreateData, { input: GiftCardCreateInput }>(
    GiftCardCreateMutation,
  );
  const { problem, attempt } = useAttempt();
  const [value, setValue] = useState('');
  const [code, setCode] = useState('');
  const [expires, setExpires] = useState('');
  const [note, setNote] = useState('');
  const [issued, setIssued] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const parsed = parsePrice(value);
  const ready = parsed !== null && Number(parsed) > 0;

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    setIssued(null);
    setCopied(false);
    let given: string | null = null;
    const ok = await attempt(async () => {
      const { giftCardCreate } = await create.mutateAsync({
        input: {
          initialValue: parsed!,
          ...(code.trim() && { code: code.trim() }),
          ...(expires && { expiresOn: expires }),
          ...(note.trim() && { note: note.trim() }),
        },
      });
      given = giftCardCreate.giftCardCode;
      return giftCardCreate;
    });
    if (ok) {
      setIssued(given);
      setValue('');
      setCode('');
      setExpires('');
      setNote('');
    }
  };

  return (
    <FormSection title={t('giftCards.issue')} hint={t('giftCards.issueHint')}>
      <form onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-3">
        <TextField
          label={t('giftCards.value')}
          hint={t('giftCards.valueHint')}
          inputMode="decimal"
          ltr
          required
          value={value}
          error={value && parsed === null ? t('returns.claim.amountWrong') : null}
          onChange={(event) => setValue(event.target.value)}
        />
        <TextField
          label={t('giftCards.code')}
          hint={t('giftCards.codeHint')}
          ltr
          maxLength={24}
          autoCapitalize="characters"
          spellCheck={false}
          value={code}
          onChange={(event) => setCode(event.target.value)}
        />
        <TextField
          label={t('giftCards.expires')}
          hint={t('giftCards.expiresHint')}
          type="date"
          ltr
          value={expires}
          onChange={(event) => setExpires(event.target.value)}
        />
        <TextField
          label={t('giftCards.note')}
          dir="auto"
          maxLength={500}
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
        {problem && <Alert tone="danger">{problem}</Alert>}
        {issued && (
          <Alert tone="success">
            <span className="flex flex-col gap-2">
              <span>{t('giftCards.issued')}</span>
              <span
                className="num text-[length:var(--hatti-type-title-size)] font-semibold"
                dir="ltr"
              >
                {issued}
              </span>
              <Button
                variant="secondary"
                className="self-start"
                icon={<Copy aria-hidden className="size-5" />}
                onClick={() =>
                  void navigator.clipboard?.writeText(issued).then(() => setCopied(true))
                }
              >
                {copied ? t('giftCards.copied') : t('giftCards.copy')}
              </Button>
            </span>
          </Alert>
        )}
        <Button
          type="submit"
          className="self-start"
          busy={create.isPending}
          disabled={!ready}
          icon={<Gift aria-hidden className="size-5" />}
        >
          {t('giftCards.create')}
        </Button>
      </form>
    </FormSection>
  );
}

/** What is added to a card, or taken from it, by hand, with a note for the shop's records. */
function Adjust({
  card,
  way,
  onDone,
}: {
  card: GiftCard;
  way: 'add' | 'take';
  onDone: () => void;
}) {
  const { t } = useLocale();
  const move = useAdminMutation<GiftCardPayloadData, Record<string, unknown>>(
    way === 'add' ? GiftCardCreditMutation : GiftCardDebitMutation,
  );
  const { problem, attempt } = useAttempt();
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const parsed = parsePrice(amount);
  const ready = parsed !== null && Number(parsed) > 0;

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    const money = { amount: parsed, currencyCode: 'PKR' };
    const extra = note.trim() ? { note: note.trim() } : {};
    const ok = await attempt(async () => {
      const data = await move.mutateAsync({
        id: card.id,
        input: way === 'add' ? { creditAmount: money, ...extra } : { debitAmount: money, ...extra },
      });
      return Object.values(data)[0]!;
    });
    if (ok) onDone();
  };

  return (
    <form onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-3">
      <TextField
        label={way === 'add' ? t('giftCards.addAmount') : t('giftCards.takeAmount')}
        inputMode="decimal"
        ltr
        value={amount}
        error={amount && parsed === null ? t('returns.claim.amountWrong') : null}
        onChange={(event) => setAmount(event.target.value)}
      />
      <TextField
        label={t('giftCards.why')}
        dir="auto"
        value={note}
        onChange={(event) => setNote(event.target.value)}
      />
      {problem && <Alert tone="danger">{problem}</Alert>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" busy={move.isPending} disabled={!ready}>
          {t('giftCards.save')}
        </Button>
        <Button variant="tertiary" onClick={onDone}>
          {t('returns.cancel')}
        </Button>
      </div>
    </form>
  );
}

/**
 * A card's last day, note and, for those who read customers, who it was given to, changed as
 * Shopify's giftCardUpdate changes them (ADR-795): only what was changed is sent, an empty day
 * making it never expire.
 */
function Change({
  card,
  customers,
  onDone,
}: {
  card: GiftCard;
  customers: boolean;
  onDone: () => void;
}) {
  const { t } = useLocale();
  const update = useAdminMutation<GiftCardPayloadData, { id: string; input: GiftCardUpdateInput }>(
    GiftCardUpdateMutation,
  );
  const { problem, attempt } = useAttempt();
  const [expires, setExpires] = useState(card.expiresOn ?? '');
  const [note, setNote] = useState(card.note);
  const [customer, setCustomer] = useState(card.customer ?? null);
  const [words, setWords] = useState('');
  const [searched, setSearched] = useState<string | null>(null);
  const found = useAdminQuery<CustomersData>(
    ['customers', 'giftCard', searched],
    CustomersQuery,
    { first: 10, query: searched },
    { enabled: customers && searched !== null },
  );

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const input: GiftCardUpdateInput = {
      ...(expires !== (card.expiresOn ?? '') && { expiresOn: expires || null }),
      ...(note.trim() !== card.note && { note: note.trim() }),
      ...(customers &&
        (customer?.id ?? null) !== (card.customer?.id ?? null) && {
          customerId: customer?.id ?? null,
        }),
    };
    if (Object.keys(input).length === 0) {
      onDone();
      return;
    }
    const ok = await attempt(async () => {
      const data = await update.mutateAsync({ id: card.id, input });
      return Object.values(data)[0]!;
    });
    if (ok) onDone();
  };

  const onSearch = () => {
    setSearched(words.trim() || null);
  };

  return (
    <form onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-3">
      <TextField
        label={t('giftCards.lastDayLabel')}
        hint={t('giftCards.expiresHint')}
        type="date"
        ltr
        value={expires}
        onChange={(event) => setExpires(event.target.value)}
      />
      <TextField
        label={t('giftCards.noteLabel')}
        dir="auto"
        maxLength={500}
        value={note}
        onChange={(event) => setNote(event.target.value)}
      />
      {customers && (
        <div className="flex flex-col gap-2">
          <span className="font-medium">{t('giftCards.customer')}</span>
          {customer ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 flex-1" dir="auto">
                {t('giftCards.givenTo', { name: customer.displayName })}
              </span>
              <Button variant="tertiary" onClick={() => setCustomer(null)}>
                {t('giftCards.removeCustomer')}
              </Button>
            </div>
          ) : (
            <>
              <span className="text-secondary">{t('giftCards.noCustomer')}</span>
              <div className="flex flex-wrap items-end gap-2">
                <TextField
                  label={t('giftCards.findCustomer')}
                  type="search"
                  dir="auto"
                  className="min-w-48 flex-1"
                  value={words}
                  onChange={(event) => setWords(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter') return;
                    event.preventDefault();
                    onSearch();
                  }}
                />
                <Button
                  variant="secondary"
                  icon={<Search aria-hidden className="size-5" />}
                  onClick={onSearch}
                >
                  {t('giftCards.findCustomerButton')}
                </Button>
              </div>
              {searched !== null &&
                (found.isPending ? (
                  <Loading label={t('state.loading')} />
                ) : found.isError ? (
                  <Alert tone="danger">{errorText(found.error, t)}</Alert>
                ) : found.data.customers.nodes.length === 0 ? (
                  <p className="text-secondary">{t('giftCards.noCustomerFound')}</p>
                ) : (
                  <ul className="flex flex-col gap-1">
                    {found.data.customers.nodes.map((each) => (
                      <li key={each.id}>
                        <Button
                          variant="tertiary"
                          onClick={() => {
                            setCustomer({ id: each.id, displayName: each.displayName });
                            setSearched(null);
                            setWords('');
                          }}
                        >
                          <span dir="auto">{each.displayName}</span>
                          {each.phone && (
                            <span className="num text-secondary" dir="ltr">
                              {each.phone}
                            </span>
                          )}
                        </Button>
                      </li>
                    ))}
                  </ul>
                ))}
            </>
          )}
        </div>
      )}
      {problem && <Alert tone="danger">{problem}</Alert>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" busy={update.isPending}>
          {t('giftCards.save')}
        </Button>
        <Button variant="tertiary" onClick={onDone}>
          {t('returns.cancel')}
        </Button>
      </div>
    </form>
  );
}

/** A card as the list shows it, adjusted, changed or deactivated by those who may. */
function CardRow({
  card,
  edits,
  customers,
}: {
  card: GiftCard;
  edits: boolean;
  customers: boolean;
}) {
  const { t, locale } = useLocale();
  const timezone = useShopTimezone();
  const deactivate = useAdminMutation<GiftCardPayloadData, { id: string }>(
    GiftCardDeactivateMutation,
  );
  const { problem, attempt } = useAttempt();
  const [open, setOpen] = useState<'add' | 'take' | 'change' | 'deactivate' | null>(null);
  const state = stateOf(card);
  const { colour, icon } = STATE[state];

  const onDeactivate = async () => {
    const ok = await attempt(async () => {
      const data = await deactivate.mutateAsync({ id: card.id });
      return Object.values(data)[0]!;
    });
    if (ok) setOpen(null);
  };

  return (
    <Card className="flex flex-col gap-2 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="num min-w-0 flex-1 font-medium" dir="ltr">
          •••• {card.lastCharacters}
        </span>
        <Badge colour={colour} icon={icon} label={t(`giftCards.state.${state}` as MessageKey)} />
      </div>
      <span className="text-secondary">
        {t('giftCards.left', {
          balance: formatMoney(card.balance.amount),
          initial: formatMoney(card.initialValue.amount),
        })}
      </span>
      <span className="text-secondary">
        {t('giftCards.issuedOn', { date: formatDate(card.createdAt, timezone, locale) })}
        {card.expiresOn && ` · ${t('giftCards.lastDay', { date: card.expiresOn })}`}
      </span>
      {card.customer && (
        <span className="text-secondary" dir="auto">
          {t('giftCards.givenTo', { name: card.customer.displayName })}
        </span>
      )}
      {card.note && (
        <span className="text-secondary" dir="auto">
          {card.note}
        </span>
      )}
      {problem && <Alert tone="danger">{problem}</Alert>}
      {edits && card.enabled && open === null && (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            icon={<Plus aria-hidden className="size-5" />}
            onClick={() => setOpen('add')}
          >
            {t('giftCards.add')}
          </Button>
          {Number(card.balance.amount) > 0 && (
            <Button
              variant="secondary"
              icon={<Minus aria-hidden className="size-5" />}
              onClick={() => setOpen('take')}
            >
              {t('giftCards.take')}
            </Button>
          )}
          <Button
            variant="secondary"
            icon={<Pencil aria-hidden className="size-5" />}
            onClick={() => setOpen('change')}
          >
            {t('giftCards.change')}
          </Button>
          <Button variant="tertiary" onClick={() => setOpen('deactivate')}>
            {t('giftCards.deactivate')}
          </Button>
        </div>
      )}
      {(open === 'add' || open === 'take') && (
        <Adjust card={card} way={open} onDone={() => setOpen(null)} />
      )}
      {open === 'change' && (
        <Change card={card} customers={customers} onDone={() => setOpen(null)} />
      )}
      {open === 'deactivate' && (
        <div className="flex flex-col gap-2">
          <Alert tone="warning">
            {t('giftCards.deactivateWarning', { card: card.lastCharacters })}
          </Alert>
          <div className="flex flex-wrap gap-2">
            <Button busy={deactivate.isPending} onClick={() => void onDeactivate()}>
              {t('giftCards.deactivateConfirm')}
            </Button>
            <Button variant="tertiary" onClick={() => setOpen(null)}>
              {t('returns.cancel')}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

/**
 * Gift cards (CAT-12, PAY-13, ADR-448): issued by owners and managers, each code shown once;
 * found by its last characters; added to, taken from, changed (ADR-795) or deactivated; looked
 * up by accountants and confirmation agents.
 */
export function GiftCardsPage() {
  const { t } = useLocale();
  const shop = useShop();
  const [typed, setTyped] = useState('');
  const [query, setQuery] = useState('');
  const customers = can(shop, 'read_customers');
  const cards = useAdminQuery<GiftCardsData>(['giftCards', query], GiftCardsQuery, {
    query: query || null,
    customers,
  });
  const edits = permits(shop, EDITS_GIFT_CARDS);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 pb-8">
      <h1 className="flex items-center gap-2 text-[length:var(--hatti-type-display-size)] font-semibold">
        <Gift aria-hidden className="size-7 text-secondary" />
        {t('giftCards.title')}
      </h1>
      <p className="text-secondary">{t('giftCards.intro')}</p>
      {edits && <IssueCard />}
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setQuery(typed.trim());
        }}
      >
        <div className="min-w-0 flex-1">
          <TextField
            label={t('giftCards.find')}
            ltr
            maxLength={4}
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
          />
        </div>
        <Button type="submit" variant="secondary">
          {t('giftCards.findButton')}
        </Button>
      </form>
      {cards.isPending ? (
        <Loading label={t('state.loading')} />
      ) : cards.isError ? (
        <ErrorState
          message={errorText(cards.error, t)}
          action={<Button onClick={() => void cards.refetch()}>{t('action.retry')}</Button>}
        />
      ) : cards.data.giftCards.nodes.length === 0 ? (
        <EmptyState
          title={query ? t('giftCards.noneFound') : t('giftCards.none')}
          body={t('giftCards.noneHint')}
        />
      ) : (
        <ul className="flex flex-col gap-3">
          {cards.data.giftCards.nodes.map((card) => (
            <li key={card.id}>
              <CardRow card={card} edits={edits} customers={customers} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
