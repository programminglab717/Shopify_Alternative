import { Link } from '@tanstack/react-router';
import { BadgePercent, Plus, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import {
  PaymentTermsOwedQuery,
  PriceListCreateMutation,
  PriceListDeleteMutation,
  PriceListPricesQuery,
  PriceListPricesSetMutation,
  PriceListsQuery,
  PriceListUpdateMutation,
} from '../api/operations';
import type {
  PaymentTermsOwedData,
  PriceListPayload,
  PriceListPricesData,
  PriceListPriceValue,
  PriceListsData,
  PriceListValue,
  UserError,
} from '../api/types';
import { gate, permits } from '../auth/permissions';
import { ProductPicker, TERMS_DAYS, type PickedVariant } from '../drafts/new-draft-page';
import { errorText, userErrorText } from '../i18n/errors';
import { formatDate, formatMoney } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import { SelectField } from '../settings/settings-form';
import { useAdminMutation, useAdminQuery, useShop, useShopTimezone } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, Card, EmptyState, ErrorState, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';
import { priceText } from './product-form';
import { EDITS_PRODUCTS } from './status';

/** How much a shop's lists may hold, as the core keeps them (ADR-778). */
export const PRICE_LIST_LIMITS = { perShop: 20, breaks: 5 } as const;

/** What a list's form takes, as typed. */
interface ListDraft {
  name: string;
  customerTag: string;
  percentOff: string;
  breaks: { minQuantity: string; percentOff: string }[];
  /** Days to pay, empty for none (ADR-888). */
  terms: string;
}

const BLANK: ListDraft = { name: '', customerTag: '', percentOff: '10', breaks: [], terms: '' };

function draftOf(list: PriceListValue): ListDraft {
  return {
    name: list.name,
    customerTag: list.customerTag,
    percentOff: list.percentOff,
    breaks: list.quantityBreaks.map((each) => ({
      minQuantity: String(each.minQuantity),
      percentOff: each.percentOff,
    })),
    terms: list.paymentTermsDays ? String(list.paymentTermsDays) : '',
  };
}

/** The list as the API takes it; a break's units not a whole number are sent as 0 for the core to refuse. */
export function listInput(draft: ListDraft) {
  return {
    name: draft.name,
    customerTag: draft.customerTag,
    percentOff: draft.percentOff.trim() === '' ? '0' : draft.percentOff.trim(),
    quantityBreaks: draft.breaks.map((each) => {
      const units = Number(each.minQuantity.trim());
      return {
        minQuantity: Number.isInteger(units) ? units : 0,
        percentOff: each.percentOff.trim(),
      };
    }),
    // 0 takes a list's terms away.
    paymentTermsDays: draft.terms === '' ? 0 : Number(draft.terms),
  };
}

/** A variant as the list's prices name it: "Lawn suit · Red / M", or the product's title alone. */
export function variantName(price: Pick<PriceListPriceValue, 'productTitle' | 'variantTitle'>) {
  return price.variantTitle ? `${price.productTitle} · ${price.variantTitle}` : price.productTitle;
}

/** The field a user error is about: "name", or "quantityBreaks" and the break's index. */
const fieldOf = (error: UserError) => (error.field ?? []).filter((each) => each !== 'input');

/** Makes a price list, or changes one: its name, its customers' tag, its share off and breaks. */
function ListForm({ list, onDone }: { list?: PriceListValue; onDone?: () => void }) {
  const { t } = useLocale();
  const create = useAdminMutation<{ priceListCreate: PriceListPayload }, { input: object }>(
    PriceListCreateMutation,
  );
  const update = useAdminMutation<
    { priceListUpdate: PriceListPayload },
    { id: string; input: object }
  >(PriceListUpdateMutation);
  const [draft, setDraft] = useState<ListDraft>(list ? draftOf(list) : BLANK);
  const [errors, setErrors] = useState<UserError[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const errorOn = (field: string, at?: number) => {
    const error = errors.find((each) => {
      const [name, index] = fieldOf(each);
      return name === field && (at === undefined || index === String(at));
    });
    return error ? userErrorText(error, t) : null;
  };
  const setBreak = (at: number, next: Partial<ListDraft['breaks'][number]>) =>
    setDraft({
      ...draft,
      breaks: draft.breaks.map((each, index) => (index === at ? { ...each, ...next } : each)),
    });

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setProblem(null);
    setErrors([]);
    try {
      const input = listInput(draft);
      const payload = list
        ? (await update.mutateAsync({ id: list.id, input })).priceListUpdate
        : (await create.mutateAsync({ input })).priceListCreate;
      if (payload.userErrors.length > 0) {
        setErrors(payload.userErrors);
        const shown = ['name', 'customerTag', 'percentOff', 'quantityBreaks', 'paymentTermsDays'];
        const other = payload.userErrors.find(
          (each) =>
            !shown.includes(fieldOf(each)[0] ?? '') ||
            (fieldOf(each)[0] === 'quantityBreaks' && fieldOf(each)[1] === undefined),
        );
        if (other) setProblem(userErrorText(other, t));
        return;
      }
      if (!list) setDraft(BLANK);
      onDone?.();
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  return (
    <form onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField
          label={t('priceLists.name')}
          value={draft.name}
          maxLength={100}
          required
          dir="auto"
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          error={errorOn('name')}
        />
        <TextField
          label={t('priceLists.tag')}
          hint={t('priceLists.tagHint')}
          value={draft.customerTag}
          maxLength={40}
          required
          autoComplete="off"
          dir="auto"
          onChange={(event) => setDraft({ ...draft, customerTag: event.target.value })}
          error={errorOn('customerTag')}
        />
        <TextField
          label={t('priceLists.percentOff')}
          hint={t('priceLists.percentOffHint')}
          value={draft.percentOff}
          ltr
          inputMode="decimal"
          onChange={(event) => setDraft({ ...draft, percentOff: event.target.value })}
          error={errorOn('percentOff')}
        />
        <SelectField
          label={t('priceLists.terms')}
          value={draft.terms}
          options={[
            { value: '', label: t('priceLists.termsNone') },
            ...[
              ...TERMS_DAYS.map(String),
              ...(draft.terms && !TERMS_DAYS.map(String).includes(draft.terms)
                ? [draft.terms]
                : []),
            ].map((days) => ({ value: days, label: t('drafts.paymentTerms.days', { days }) })),
          ]}
          onChange={(terms) => setDraft({ ...draft, terms })}
        />
      </div>
      {errorOn('paymentTermsDays') && <Alert tone="danger">{errorOn('paymentTermsDays')}</Alert>}
      <fieldset className="flex flex-col gap-2">
        <legend className="font-medium">{t('priceLists.breaks')}</legend>
        <p className="text-secondary">{t('priceLists.breaksHint')}</p>
        {draft.breaks.map((each, at) => (
          <div key={at} className="flex flex-wrap items-end gap-2">
            <TextField
              label={t('priceLists.breakFrom')}
              value={each.minQuantity}
              ltr
              inputMode="numeric"
              required
              onChange={(event) => setBreak(at, { minQuantity: event.target.value })}
              error={errorOn('quantityBreaks', at)}
            />
            <TextField
              label={t('priceLists.breakOff')}
              value={each.percentOff}
              ltr
              inputMode="decimal"
              required
              onChange={(event) => setBreak(at, { percentOff: event.target.value })}
            />
            <Button
              variant="tertiary"
              icon={<X aria-hidden className="size-5" />}
              aria-label={t('priceLists.removeBreak', { count: each.minQuantity || at + 1 })}
              onClick={() =>
                setDraft({ ...draft, breaks: draft.breaks.filter((_, index) => index !== at) })
              }
            >
              {t('priceLists.remove')}
            </Button>
          </div>
        ))}
        {draft.breaks.length < PRICE_LIST_LIMITS.breaks && (
          <Button
            variant="tertiary"
            icon={<Plus aria-hidden className="size-5" />}
            onClick={() =>
              setDraft({ ...draft, breaks: [...draft.breaks, { minQuantity: '', percentOff: '' }] })
            }
          >
            {t('priceLists.addBreak')}
          </Button>
        )}
      </fieldset>
      {problem && <Alert tone="danger">{problem}</Alert>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" busy={create.isPending || update.isPending}>
          {list ? t('priceLists.save') : t('priceLists.add')}
        </Button>
        {list && (
          <Button variant="tertiary" onClick={onDone}>
            {t('priceLists.cancel')}
          </Button>
        )}
      </div>
    </form>
  );
}

/** A variant's row as the prices form keeps it: its price as typed, and what it was saved at. */
interface PriceRow {
  variantId: string;
  name: string;
  retail: PriceListPriceValue['retailPrice'];
  text: string;
  saved: string | null;
}

const rowOf = (price: PriceListPriceValue): PriceRow => ({
  variantId: price.variantId,
  name: variantName(price),
  retail: price.retailPrice,
  text: priceText(price.price.amount),
  saved: priceText(price.price.amount),
});

/** The variants with a price of their own in a list, changed, added from a search or taken out. */
function Prices({ list, edits }: { list: PriceListValue; edits: boolean }) {
  const { t } = useLocale();
  const query = useAdminQuery<PriceListPricesData>(
    ['priceListPrices', list.id],
    PriceListPricesQuery,
    { id: list.id },
  );
  if (query.isPending) return <Loading label={t('state.loading')} />;
  if (query.isError) return <Alert tone="danger">{errorText(query.error, t)}</Alert>;
  return (
    <PricesForm
      key={list.updatedAt}
      list={list}
      prices={query.data.priceListPrices ?? []}
      edits={edits}
    />
  );
}

function PricesForm({
  list,
  prices,
  edits,
}: {
  list: PriceListValue;
  prices: PriceListPriceValue[];
  edits: boolean;
}) {
  const { t } = useLocale();
  const save = useAdminMutation<
    { priceListPricesSet: { prices: PriceListPriceValue[] | null; userErrors: UserError[] } },
    { id: string; prices: { variantId: string; price: string | null }[] }
  >(PriceListPricesSetMutation);
  const [rows, setRows] = useState<PriceRow[]>(() => prices.map(rowOf));
  const [removed, setRemoved] = useState<string[]>([]);
  const [problems, setProblems] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const [picking, setPicking] = useState(false);

  const change = (variantId: string, text: string) => {
    setRows(rows.map((row) => (row.variantId === variantId ? { ...row, text } : row)));
    setSaved(false);
  };
  const add = (picked: PickedVariant) => {
    setSaved(false);
    if (rows.some((row) => row.variantId === picked.variantId)) return;
    setRemoved(removed.filter((each) => each !== picked.variantId));
    setRows([
      ...rows,
      {
        variantId: picked.variantId,
        name: picked.title,
        retail: picked.price,
        text: '',
        saved: null,
      },
    ]);
  };
  const remove = (row: PriceRow) => {
    setRows(rows.filter((each) => each.variantId !== row.variantId));
    if (row.saved !== null) setRemoved([...removed, row.variantId]);
    setSaved(false);
  };

  const onSave = async (event: FormEvent) => {
    event.preventDefault();
    setProblems([]);
    const sent = [
      ...rows
        .filter((row) => row.text.trim() !== row.saved)
        .map((row) => ({ variantId: row.variantId, price: row.text.trim() })),
      ...removed.map((variantId) => ({ variantId, price: null })),
    ];
    if (sent.length === 0) {
      setSaved(true);
      return;
    }
    try {
      const { priceListPricesSet } = await save.mutateAsync({ id: list.id, prices: sent });
      if (priceListPricesSet.userErrors.length > 0) {
        setProblems(
          priceListPricesSet.userErrors.map((error) => {
            const at = error.field?.[1];
            const row = at === undefined ? undefined : sent[Number(at)];
            const name = rows.find((each) => each.variantId === row?.variantId)?.name;
            const message = userErrorText(error, t);
            return name ? `${name}: ${message}` : message;
          }),
        );
        return;
      }
      setRows((priceListPricesSet.prices ?? []).map(rowOf));
      setRemoved([]);
      setSaved(true);
    } catch (failure) {
      setProblems([errorText(failure, t)]);
    }
  };

  return (
    <form
      onSubmit={(event) => void onSave(event)}
      className="flex flex-col gap-3 rounded-control border border-line p-3"
    >
      <h3 className="font-medium">{t('priceLists.prices')}</h3>
      <p className="text-secondary">{t('priceLists.pricesHint')}</p>
      {rows.length === 0 ? (
        <p className="text-secondary">{t('priceLists.noPrices')}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line rounded-control border border-line">
          {rows.map((row) => (
            <li key={row.variantId} className="flex flex-wrap items-center gap-3 px-3 py-2">
              <span className="flex min-w-0 flex-1 flex-col">
                <span dir="auto">{row.name}</span>
                <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
                  {t('priceLists.retail', {
                    price: formatMoney(row.retail.amount, row.retail.currencyCode),
                  })}
                </span>
              </span>
              <input
                aria-label={t('priceLists.priceOf', { title: row.name })}
                value={row.text}
                dir="ltr"
                inputMode="decimal"
                required
                disabled={!edits}
                onChange={(event) => change(row.variantId, event.target.value)}
                className="min-h-12 w-32 rounded-control border border-line bg-surface px-3 md:min-h-10"
              />
              {edits && (
                <Button
                  variant="tertiary"
                  icon={<Trash2 aria-hidden className="size-5" />}
                  aria-label={t('priceLists.removePrice', { title: row.name })}
                  onClick={() => remove(row)}
                >
                  {t('priceLists.remove')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {problems.map((each) => (
        <Alert key={each} tone="danger">
          {each}
        </Alert>
      ))}
      {saved && <Alert tone="success">{t('priceLists.saved')}</Alert>}
      {edits && (
        <>
          {picking ? (
            <ProductPicker onAdd={add} />
          ) : (
            <Button
              variant="tertiary"
              icon={<Plus aria-hidden className="size-5" />}
              onClick={() => setPicking(true)}
            >
              {t('priceLists.addVariants')}
            </Button>
          )}
          <div>
            <Button type="submit" busy={save.isPending}>
              {t('priceLists.savePrices')}
            </Button>
          </div>
        </>
      )}
    </form>
  );
}

/** A price list: who it is for and what it takes off, its prices, and what can be done. */
function ListCard({ list, edits }: { list: PriceListValue; edits: boolean }) {
  const { t } = useLocale();
  const remove = useAdminMutation<
    { priceListDelete: { deletedPriceListId: string | null; userErrors: UserError[] } },
    { id: string }
  >(PriceListDeleteMutation);
  const [open, setOpen] = useState<'edit' | 'prices' | 'delete' | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const toggle = (panel: 'edit' | 'prices' | 'delete') => setOpen(open === panel ? null : panel);

  const onDelete = async () => {
    setProblem(null);
    try {
      const { priceListDelete } = await remove.mutateAsync({ id: list.id });
      if (priceListDelete.userErrors[0]) {
        setProblem(userErrorText(priceListDelete.userErrors[0], t));
      }
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex flex-col gap-1">
        <h2 className="font-semibold" dir="auto">
          {list.name}
        </h2>
        <span className="text-secondary" dir="auto">
          {t('priceLists.forTag', { tag: list.customerTag })}
        </span>
      </div>
      <ul className="flex flex-col gap-1">
        {list.percentOff !== '0' && (
          <li>{t('priceLists.summaryOff', { percent: list.percentOff })}</li>
        )}
        {list.quantityBreaks.map((each) => (
          <li key={each.minQuantity}>
            {t('priceLists.breakSummary', { percent: each.percentOff, count: each.minQuantity })}
          </li>
        ))}
        {list.paymentTermsDays && (
          <li>{t('priceLists.termsSummary', { days: list.paymentTermsDays })}</li>
        )}
        <li className="text-secondary">{t('priceLists.priced', { count: list.pricedVariants })}</li>
      </ul>
      {problem && <Alert tone="danger">{problem}</Alert>}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          aria-expanded={open === 'prices'}
          onClick={() => toggle('prices')}
        >
          {t('priceLists.showPrices')}
        </Button>
        {edits && (
          <>
            <Button variant="tertiary" onClick={() => toggle('edit')}>
              {t('priceLists.edit')}
            </Button>
            <Button
              variant="danger"
              icon={<Trash2 aria-hidden className="size-5" />}
              onClick={() => toggle('delete')}
            >
              {t('priceLists.delete')}
            </Button>
          </>
        )}
      </div>
      {open === 'delete' && (
        <div className="flex flex-col gap-2 rounded-control border border-line p-3">
          <p>{t('priceLists.deleteConfirm', { name: list.name })}</p>
          <div className="flex flex-wrap gap-2">
            <Button variant="destructive" busy={remove.isPending} onClick={() => void onDelete()}>
              {t('priceLists.deleteYes')}
            </Button>
            <Button variant="tertiary" onClick={() => setOpen(null)}>
              {t('priceLists.cancel')}
            </Button>
          </div>
        </div>
      )}
      {open === 'edit' && <ListForm list={list} onDone={() => setOpen(null)} />}
      {open === 'prices' && <Prices list={list} edits={edits} />}
    </Card>
  );
}

/** Who sees what wholesale customers owe on terms: those who read orders and handle money. */
export const READS_OWED = gate(['owner', 'manager', 'accountant'], 'read_orders');

/**
 * What wholesale customers owe on orders on payment terms (ADR-888), the most overdue first,
 * each to their customer's page; nothing where none is owed.
 */
function TermsOwed() {
  const { t, locale } = useLocale();
  const shop = useShop();
  const timezone = useShopTimezone();
  const query = useAdminQuery<PaymentTermsOwedData>(['paymentTermsOwed'], PaymentTermsOwedQuery);
  // Absent where an older core, or a fake one, leaves it out.
  const owed = query.data?.paymentTermsOwed as PaymentTermsOwedData['paymentTermsOwed'] | undefined;
  if (!owed || owed.customers.length === 0) return null;
  return (
    <Card className="p-4">
      <section aria-labelledby="price-lists-owed" className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h2 id="price-lists-owed" className="font-semibold">
            {t('priceLists.owed')}
          </h2>
          <p className="text-secondary">
            {t('priceLists.owedTotal', {
              owed: formatMoney(owed.owed.amount),
              overdue: formatMoney(owed.overdue.amount),
            })}
          </p>
        </div>
        <ul className="flex flex-col divide-y divide-line">
          {owed.customers.map((each) => (
            <li key={each.customerId} className="flex flex-wrap items-baseline gap-x-3 py-2">
              <Link
                to="/$shopId/customers/$customerId"
                params={{ shopId: shop.id, customerId: each.customerId }}
                className="min-w-0 flex-1 font-medium underline-offset-4 hover:underline"
                dir="auto"
              >
                {each.name || t('priceLists.owedNoName')}
              </Link>
              <span className="num">{formatMoney(each.owed.amount)}</span>
              <span
                className={`w-full text-[length:var(--hatti-type-body-sm-size)] ${
                  Number(each.overdue.amount) > 0 ? 'text-danger' : 'text-secondary'
                }`}
              >
                {Number(each.overdue.amount) > 0
                  ? t('priceLists.owedOverdue', {
                      count: each.orders,
                      overdue: formatMoney(each.overdue.amount),
                      date: formatDate(each.oldestDueAt, timezone, locale),
                    })
                  : t('priceLists.owedDue', {
                      count: each.orders,
                      date: formatDate(each.oldestDueAt, timezone, locale),
                    })}
              </span>
            </li>
          ))}
        </ul>
        <Link
          to="/$shopId/orders"
          params={{ shopId: shop.id }}
          search={{ q: 'payment_terms:owed' }}
          className="self-start text-primary underline-offset-4 hover:underline"
        >
          {t('priceLists.owedOrders')}
        </Link>
      </section>
    </Card>
  );
}

/**
 * Wholesale price lists (CUS-06, ADR-779): each for the customers with a tag, a share off every
 * item, prices of the shop's own for some variants, and more off as more of a variant is bought;
 * made and changed by those who change products.
 */
export function PriceListsPage() {
  const { t } = useLocale();
  const shop = useShop();
  const edits = permits(shop, EDITS_PRODUCTS);
  const query = useAdminQuery<PriceListsData>(['priceLists'], PriceListsQuery);
  const lists = query.data?.priceLists ?? [];

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 pb-8">
      <h1 className="flex items-center gap-2 text-[length:var(--hatti-type-display-size)] font-semibold">
        <BadgePercent aria-hidden className="size-7 text-secondary" />
        {t('priceLists.title')}
      </h1>
      <p className="text-secondary">{t('priceLists.intro')}</p>
      {permits(shop, READS_OWED) && <TermsOwed />}
      {edits && query.isSuccess && lists.length < PRICE_LIST_LIMITS.perShop && (
        <Card className="flex flex-col gap-3 p-4">
          <h2 className="font-semibold">{t('priceLists.new')}</h2>
          <ListForm />
        </Card>
      )}
      {query.isPending ? (
        <Loading label={t('state.loading')} />
      ) : query.isError ? (
        <ErrorState
          message={errorText(query.error, t)}
          action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
        />
      ) : lists.length === 0 ? (
        <EmptyState title={t('priceLists.none')} body={t('priceLists.noneHint')} />
      ) : (
        <ul className="flex flex-col gap-3">
          {lists.map((list) => (
            <li key={list.id}>
              <ListCard list={list} edits={edits} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
