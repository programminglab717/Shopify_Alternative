import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { ArrowLeft, Plus, Search, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import {
  LowStockQuery,
  PurchaseOrderCreateMutation,
  PurchaseOrderFormQuery,
  StockSearchQuery,
  SupplierCreateMutation,
} from '../api/operations';
import type {
  LowStockData,
  PurchaseOrderFormData,
  StockSearchData,
  StockSeason,
  UserError,
} from '../api/types';
import { errorText } from '../i18n/errors';
import { useLocale } from '../i18n/locale';
import { parseStock } from '../products/product-form';
import { useAttempt } from '../returns/parcel';
import { SelectField } from '../settings/settings-form';
import { useAdminMutation, useAdminQuery, useShop } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, Card, ErrorState, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';

export interface Line {
  itemId: string;
  title: string;
  quantity: string;
  unitCost: string;
  /** What a line from what runs low is reckoned from, to suggest how many again. */
  basis?: Basis;
}

/** Where a variant running low stands: what is for sale, on its way, and sold of late. */
interface Basis {
  available: number;
  incoming: number;
  /** Units sold in the last 30 days. */
  sold: number;
  /** A season ahead, and how much faster it sold in it last year (ADR-863). */
  season?: StockSeason | null;
}

/** Today in Pakistan, YYYY-MM-DD: UTC+5 all year. */
function pkToday(): string {
  return new Date(Date.now() + 5 * 3_600_000).toISOString().slice(0, 10);
}

/** The day `days` after `day`, both YYYY-MM-DD. */
export function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** How many of `days` from `today` fall in `season`. */
export function seasonDays(season: StockSeason, today: string, days: number): number {
  const day = (value: string) => Date.parse(`${value}T00:00:00Z`) / 86_400_000;
  const first = Math.max(day(today), day(season.startsOn));
  const last = Math.min(day(today) + days - 1, day(season.endsOn));
  return Math.max(0, last - first + 1);
}

/** The days a reorder can be made to last, at the pace a variant sold (ADR-368). */
export const COVER_DAYS = [15, 30, 45, 60, 90] as const;

/**
 * How many to order of a variant running low (ADR-354, ADR-368): enough to last `days` at the
 * pace it sold in the last 30, the days of a season ahead at that pace times the season's lift
 * (ADR-863), or, where none sold, for twice the shop's low mark to be for sale; less what is for
 * sale and on its way already; at least one.
 */
export function suggestedQuantity(
  basis: Basis,
  threshold: number,
  days: number,
  today: string = pkToday(),
): number {
  const lift = basis.season?.lift ?? null;
  const inSeason = basis.season && lift !== null ? seasonDays(basis.season, today, days) : 0;
  const wanted =
    basis.sold > 0
      ? Math.ceil((basis.sold * (days - inSeason + inSeason * (lift ?? 1))) / 30)
      : threshold * 2;
  return Math.max(1, wanted - basis.available - basis.incoming);
}

/**
 * Lines from what runs low suggested again (ADR-368, ADR-892): enough for the supplier's lead
 * time, sold while the goods are on their way, and the days chosen after they come; the rest as
 * typed.
 */
export function resuggest(lines: Line[], threshold: number, days: number, leadDays: number) {
  return lines.map((line) =>
    line.basis
      ? { ...line, quantity: String(suggestedQuantity(line.basis, threshold, days + leadDays)) }
      : line,
  );
}

type Created<K extends string, T> = Record<K, { userErrors: UserError[] } & T>;

export interface NewPurchaseOrderSearch {
  /** Variants running low, chosen on the stock page, comma-separated. */
  variants?: string;
  /** The location they run low at, where the goods go. */
  location?: string;
}

export function validateNewPurchaseOrderSearch(
  search: Record<string, unknown>,
): NewPurchaseOrderSearch {
  return {
    variants: typeof search.variants === 'string' ? search.variants : undefined,
    location: typeof search.location === 'string' ? search.location : undefined,
  };
}

const NEW_SUPPLIER = '+new';
/** An amount as typed: whole rupees, or with paisa. */
export const AMOUNT = /^\d+(\.\d{1,2})?$/;

const variantTitle = (product: string, variant: string) =>
  variant && variant !== 'Default Title' ? `${product} · ${variant}` : product;

/** A supplier added from the order's form, then chosen for it. */
function NewSupplier({
  onAdded,
  onCancel,
}: {
  onAdded: (id: string) => void;
  onCancel: () => void;
}) {
  const { t } = useLocale();
  const create = useAdminMutation<
    Created<'supplierCreate', { supplier: { id: string } | null }>,
    { input: Record<string, unknown> }
  >(SupplierCreateMutation);
  const { problem, attempt } = useAttempt();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const onSubmit = async () => {
    let added: string | null = null;
    const ok = await attempt(async () => {
      const { supplierCreate } = await create.mutateAsync({
        input: { name, phone: phone || null },
      });
      added = supplierCreate.supplier?.id ?? null;
      return supplierCreate;
    });
    if (ok && added) onAdded(added);
  };
  return (
    <div className="flex flex-col gap-3 rounded-card border border-line p-3">
      <TextField
        label={t('po.supplierName')}
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <TextField
        label={t('po.supplierPhone')}
        inputMode="tel"
        ltr
        value={phone}
        onChange={(event) => setPhone(event.target.value)}
      />
      {problem && <Alert tone="danger">{problem}</Alert>}
      <div className="flex flex-wrap gap-2">
        <Button busy={create.isPending} disabled={!name.trim()} onClick={() => void onSubmit()}>
          {t('po.supplierAdd')}
        </Button>
        <Button variant="tertiary" onClick={onCancel}>
          {t('returns.cancel')}
        </Button>
      </div>
    </div>
  );
}

/** Variants found by words, each added to the order, or another list of goods, with one tap. */
export function FindVariants({
  chosen,
  onAdd,
  findLabel,
  addLabel,
}: {
  chosen: Set<string>;
  onAdd: (line: Line) => void;
  /** What the search says it finds; products to order by default. */
  findLabel?: string;
  /** What adding a variant says; ordering it by default. */
  addLabel?: (title: string) => string;
}) {
  const { t } = useLocale();
  const [words, setWords] = useState('');
  const [searched, setSearched] = useState<string | null>(null);
  const query = useAdminQuery<StockSearchData>(
    ['stockSearch', searched],
    StockSearchQuery,
    { query: searched },
    { enabled: searched !== null },
  );
  return (
    <div className="flex flex-col gap-2">
      <div role="search" className="flex gap-2">
        <input
          type="search"
          value={words}
          onChange={(event) => setWords(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              setSearched(words.trim());
            }
          }}
          aria-label={findLabel ?? t('po.findProducts')}
          placeholder={findLabel ?? t('po.findProducts')}
          className="min-h-12 min-w-0 flex-1 rounded-control border border-line bg-surface px-3 md:min-h-10"
        />
        <Button
          variant="secondary"
          icon={<Search aria-hidden className="size-5" />}
          onClick={() => setSearched(words.trim())}
        >
          {t('drafts.find')}
        </Button>
      </div>
      {query.isError && <Alert tone="danger">{errorText(query.error, t)}</Alert>}
      {query.data &&
        (query.data.products.nodes.length === 0 ? (
          <p className="text-secondary">{t('drafts.noProducts')}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-line">
            {query.data.products.nodes.flatMap((product) =>
              product.variants.map((variant) => {
                const title = variantTitle(product.title, variant.title);
                return (
                  <li key={variant.id} className="flex items-center justify-between gap-2 py-2">
                    <span dir="auto">{title}</span>
                    <Button
                      variant="tertiary"
                      aria-label={addLabel ? addLabel(title) : t('po.addLine', { title })}
                      icon={<Plus aria-hidden className="size-5" />}
                      disabled={chosen.has(variant.inventoryItem.id)}
                      onClick={() =>
                        onAdd({
                          itemId: variant.inventoryItem.id,
                          title,
                          quantity: '1',
                          unitCost: '',
                        })
                      }
                    />
                  </li>
                );
              }),
            )}
          </ul>
        ))}
    </div>
  );
}

/** What it starts with, when ordering what runs low. */
interface Start {
  supplierId: string;
  /** The shop's low mark, for variants that sold none. */
  threshold: number;
  lines: Line[];
}

/**
 * The lines for the variants chosen from what runs low (ADR-354): of each, as many as
 * suggestedQuantity says for `days`, at what it cost last; from the supplier most of them came
 * from last.
 */
export function startFromLow(
  low: LowStockData,
  variantIds: readonly string[],
  days: number = 30,
): Start {
  const threshold = low.inventorySettings.lowStockThreshold;
  const chosen = low.inventoryLowStock.nodes.filter((each) => variantIds.includes(each.variantId));
  const counts = new Map<string, number>();
  for (const each of chosen) {
    const id = each.lastSupplier?.id;
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const supplierId = [...counts].sort((x, y) => y[1] - x[1])[0]?.[0] ?? '';
  return {
    supplierId,
    threshold,
    lines: chosen.map((each) => {
      const basis = {
        available: each.available,
        incoming: each.incoming,
        sold: each.soldLast30Days,
        season: each.season,
      };
      return {
        itemId: each.inventoryItem.id,
        title: variantTitle(each.productTitle, each.variantTitle),
        quantity: String(suggestedQuantity(basis, threshold, days)),
        unitCost: each.lastUnitCost?.amount.replace(/\.00$/, '') ?? '',
        basis,
      };
    }),
  };
}

/** A new purchase order: a supplier, where the goods go, and what of them, with what each costs. */
export function NewPurchaseOrderPage() {
  const { t } = useLocale();
  const { variants, location } = useSearch({ from: '/$shopId/purchase-orders/new' });
  const chosen = variants?.split(',').filter(Boolean) ?? [];
  const form = useAdminQuery<PurchaseOrderFormData>(['purchaseOrderForm'], PurchaseOrderFormQuery);
  // As the stock page listed them: at the location chosen there, or for sale online (ADR-359).
  const low = useAdminQuery<LowStockData>(
    ['lowStock'],
    LowStockQuery,
    { locationId: location ?? null },
    { enabled: chosen.length > 0 },
  );

  if (form.isPending || (chosen.length > 0 && low.isPending)) {
    return <Loading label={t('state.loading')} />;
  }
  if (form.isError) return <ErrorState message={errorText(form.error, t)} />;
  if (low.isError) return <ErrorState message={errorText(low.error, t)} />;
  return (
    <OrderForm
      form={form.data}
      start={low.data ? startFromLow(low.data, chosen) : null}
      locationId={location}
    />
  );
}

function OrderForm({
  form,
  start,
  locationId: goesTo,
}: {
  form: PurchaseOrderFormData;
  start: Start | null;
  locationId: string | undefined;
}) {
  const { t } = useLocale();
  const { id: shopId } = useShop();
  const navigate = useNavigate();
  const create = useAdminMutation<
    Created<'purchaseOrderCreate', { purchaseOrder: { id: string } | null }>,
    { input: Record<string, unknown> }
  >(PurchaseOrderCreateMutation);
  const { problem, attempt } = useAttempt();
  const suppliers = form.suppliers;
  const leadOf = (id: string) => suppliers.find((each) => each.id === id)?.leadTimeDays ?? 0;
  const [supplier, setSupplier] = useState(start?.supplierId ?? '');
  const supplierId = supplier || suppliers[0]?.id || NEW_SUPPLIER;
  const leadDays = leadOf(supplierId);
  const [location, setLocation] = useState(
    goesTo && form.locations.nodes.some((each) => each.id === goesTo) ? goesTo : '',
  );
  const [reference, setReference] = useState('');
  // Null until typed: then the day the supplier's lead time says the goods come (ADR-892).
  const [expectedOn, setExpectedOn] = useState<string | null>(null);
  const expected = expectedOn ?? (leadDays > 0 ? addDays(pkToday(), leadDays) : '');
  const [days, setDays] = useState(30);
  const threshold = start?.threshold ?? 0;
  const [lines, setLines] = useState<Line[]>(() =>
    resuggest(start?.lines ?? [], threshold, 30, leadDays),
  );
  const paced = lines.some((line) => (line.basis?.sold ?? 0) > 0);
  const cover = (chosen: number) => {
    setDays(chosen);
    setLines((now) => resuggest(now, threshold, chosen, leadDays));
  };
  const choose = (id: string) => {
    setSupplier(id);
    setLines((now) => resuggest(now, threshold, days, leadOf(id)));
  };

  const places = form.locations.nodes;
  const locationId = location || places.find((each) => each.isPrimary)?.id || places[0]?.id || '';
  const valid =
    supplierId !== NEW_SUPPLIER &&
    locationId !== '' &&
    lines.length > 0 &&
    lines.every(
      (line) =>
        (parseStock(line.quantity) ?? 0) > 0 &&
        (!line.unitCost.trim() || AMOUNT.test(line.unitCost.trim())),
    );
  const change = (index: number, patch: Partial<Line>) =>
    setLines((now) => now.map((line, at) => (at === index ? { ...line, ...patch } : line)));

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!valid) return;
    let id: string | null = null;
    const ok = await attempt(async () => {
      const { purchaseOrderCreate } = await create.mutateAsync({
        input: {
          supplierId,
          locationId,
          reference: reference.trim() || null,
          expectedOn: expected || null,
          lines: lines.map((line) => ({
            inventoryItemId: line.itemId,
            quantity: parseStock(line.quantity),
            unitCost: line.unitCost.trim() || null,
          })),
        },
      });
      id = purchaseOrderCreate.purchaseOrder?.id ?? null;
      return purchaseOrderCreate;
    });
    if (ok && id) {
      void navigate({
        to: '/$shopId/purchase-orders/$purchaseOrderId',
        params: { shopId, purchaseOrderId: id },
      });
    }
  };

  return (
    <form
      onSubmit={(event) => void onSubmit(event)}
      className="mx-auto flex max-w-3xl flex-col gap-4"
    >
      <Link
        to="/$shopId/purchase-orders"
        params={{ shopId }}
        className="inline-flex min-h-10 items-center gap-1 self-start text-secondary hover:text-text"
      >
        <ArrowLeft aria-hidden className="size-5 rtl:rotate-180" />
        {t('po.title')}
      </Link>
      <h1 className="text-[length:var(--hatti-type-display-size)] font-semibold">{t('po.new')}</h1>
      <Card className="flex flex-col gap-3 p-4">
        <SelectField
          label={t('po.supplier')}
          value={supplierId}
          options={[
            ...suppliers.map((each) => ({ value: each.id, label: each.name })),
            { value: NEW_SUPPLIER, label: t('po.supplierNew') },
          ]}
          onChange={choose}
        />
        {supplierId === NEW_SUPPLIER && (
          <NewSupplier
            onAdded={(id) => setSupplier(id)}
            onCancel={() => choose(suppliers[0]?.id ?? NEW_SUPPLIER)}
          />
        )}
        <SelectField
          label={t('po.location')}
          value={locationId}
          options={places.map((each) => ({ value: each.id, label: each.name }))}
          onChange={setLocation}
        />
        <div className="flex flex-wrap gap-3">
          <TextField
            label={t('po.reference')}
            hint={t('po.referenceHint')}
            value={reference}
            onChange={(event) => setReference(event.target.value)}
          />
          <TextField
            label={t('po.expectedOn')}
            hint={
              expectedOn === null && leadDays > 0
                ? t('po.expectedFromLead', { count: String(leadDays) })
                : undefined
            }
            type="date"
            ltr
            value={expected}
            onChange={(event) => setExpectedOn(event.target.value)}
          />
        </div>
      </Card>
      <Card className="flex flex-col gap-3 p-4">
        <h2 className="font-semibold">{t('po.lines')}</h2>
        {start && start.lines.length > 0 && <p className="text-secondary">{t('po.fromLow')}</p>}
        {paced && (
          <SelectField
            label={t('po.coverDays')}
            value={String(days)}
            options={COVER_DAYS.map((each) => ({
              value: String(each),
              label: t('po.days', { count: String(each) }),
            }))}
            onChange={(value) => cover(Number(value))}
          />
        )}
        {paced && leadDays > 0 && (
          <p className="text-secondary">{t('po.coversLead', { count: String(leadDays) })}</p>
        )}
        <FindVariants
          chosen={new Set(lines.map((line) => line.itemId))}
          onAdd={(line) => setLines((now) => [...now, line])}
        />
        {lines.length > 0 && (
          <ul className="flex flex-col divide-y divide-line">
            {lines.map((line, index) => (
              <li key={line.itemId} className="flex flex-wrap items-end gap-3 py-2">
                <span className="min-w-0 flex-1 font-medium" dir="auto">
                  {line.title}
                </span>
                <TextField
                  label={t('po.quantityOf', { title: line.title })}
                  inputMode="numeric"
                  ltr
                  className="w-24"
                  value={line.quantity}
                  onChange={(event) => change(index, { quantity: event.target.value })}
                />
                <TextField
                  label={t('po.unitCostOf', { title: line.title })}
                  inputMode="decimal"
                  ltr
                  className="w-32"
                  value={line.unitCost}
                  error={
                    line.unitCost.trim() && !AMOUNT.test(line.unitCost.trim())
                      ? t('po.badCost')
                      : null
                  }
                  onChange={(event) => change(index, { unitCost: event.target.value })}
                />
                <Button
                  variant="tertiary"
                  aria-label={t('po.removeLine', { title: line.title })}
                  icon={<Trash2 aria-hidden className="size-5" />}
                  onClick={() => setLines((now) => now.filter((_, at) => at !== index))}
                />
              </li>
            ))}
          </ul>
        )}
      </Card>
      {problem && <Alert tone="danger">{problem}</Alert>}
      <Button type="submit" className="self-start" busy={create.isPending} disabled={!valid}>
        {t('po.save')}
      </Button>
    </form>
  );
}
