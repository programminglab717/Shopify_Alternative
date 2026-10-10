import { Link, useNavigate } from '@tanstack/react-router';
import { ChevronDown, ChevronUp, FileSpreadsheet, ScanBarcode, Search, Truck } from 'lucide-react';
import { useId, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import {
  InventoryAdjustMutation,
  InventoryItemQuery,
  InventoryMoveMutation,
  InventorySetQuantitiesMutation,
  InventorySettingsUpdateMutation,
  LocationsQuery,
  LowStockQuery,
  StockSearchQuery,
} from '../api/operations';
import type {
  InventoryItemData,
  LocationsData,
  LowStockData,
  StockLevel,
  StockSearchData,
  UserError,
} from '../api/types';
import type { StaffRole } from '../auth/session';
import { errorText } from '../i18n/errors';
import { formatCount } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import { messages } from '../i18n/messages';
import type { MessageKey } from '../i18n/messages';
import { parseStock } from '../products/product-form';
import { useAttempt } from '../returns/parcel';
import { SelectField } from '../settings/settings-form';
import { useAdminMutation, useAdminQuery, useShop } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, Card, EmptyState, ErrorState, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';
import { Scanner, canScan } from './scanner';
import { StockCount } from './stock-count';
import { StockChanges } from './stock-changes';

/** Those who change stock, as the core lets them (`write_inventory`); every role sees it. */
export const EDITS_STOCK: readonly StaffRole[] = ['owner', 'manager'];

/** Why stock is added, and why it is taken away, as the core names them. */
const ADDS = ['received', 'restock', 'correction', 'other'] as const;
const TAKES = ['damaged', 'shrinkage', 'quality_control', 'correction', 'other'] as const;

type Mutated = Record<string, { userErrors: UserError[] }>;

function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <Card className="p-4">
      <section aria-labelledby={id} className="flex flex-col gap-3">
        <h2 id={id} className="font-semibold">
          {title}
        </h2>
        {children}
      </section>
    </Card>
  );
}

/** A reason or quantity's name in words, or as the core wrote it where it has none. */
function useWord() {
  const { t } = useLocale();
  return (kind: 'reason' | 'name', word: string) => {
    const key = `stock.${kind}.${word}`;
    return key in messages.en ? t(key as MessageKey) : word.replace(/_/g, ' ');
  };
}

/** Stock added or taken away at a location, with why. */
function AdjustForm({
  itemId,
  level,
  onDone,
}: {
  itemId: string;
  level: StockLevel;
  onDone: () => void;
}) {
  const { t } = useLocale();
  const word = useWord();
  const adjust = useAdminMutation<Mutated, { input: Record<string, unknown> }>(
    InventoryAdjustMutation,
  );
  const { problem, attempt } = useAttempt();
  const [direction, setDirection] = useState<'add' | 'take'>('add');
  const [reason, setReason] = useState<string>('received');
  const [count, setCount] = useState('');
  const units = parseStock(count);
  const reasons = direction === 'add' ? ADDS : TAKES;
  const tooMany = direction === 'take' && units !== null && units > level.onHand;

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!units || tooMany) return;
    const ok = await attempt(
      async () =>
        Object.values(
          await adjust.mutateAsync({
            input: {
              name: 'available',
              reason,
              changes: [
                {
                  inventoryItemId: itemId,
                  locationId: level.location.id,
                  delta: direction === 'add' ? units : -units,
                },
              ],
            },
          }),
        )[0]!,
    );
    if (ok) onDone();
  };

  return (
    <form onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-3">
      <fieldset className="flex flex-wrap gap-4">
        <legend className="sr-only">{t('stock.direction')}</legend>
        {(['add', 'take'] as const).map((each) => (
          <label key={each} className="flex min-h-10 items-center gap-2">
            <input
              type="radio"
              name="direction"
              checked={direction === each}
              onChange={() => {
                setDirection(each);
                setReason(each === 'add' ? 'received' : 'damaged');
              }}
              className="size-5 accent-[var(--hatti-color-primary)]"
            />
            {t(each === 'add' ? 'stock.add' : 'stock.take')}
          </label>
        ))}
      </fieldset>
      <div className="flex flex-wrap items-end gap-3">
        <TextField
          label={t('stock.howMany')}
          inputMode="numeric"
          ltr
          className="w-28"
          value={count}
          error={
            count.trim() && !units
              ? t('stock.badCount')
              : tooMany
                ? t('stock.tooMany', { count: formatCount(level.onHand) })
                : null
          }
          onChange={(event) => setCount(event.target.value)}
        />
        <SelectField
          label={t('stock.why')}
          value={reason}
          options={reasons.map((each) => ({ value: each, label: word('reason', each) }))}
          onChange={setReason}
        />
      </div>
      {problem && <Alert tone="danger">{problem}</Alert>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" busy={adjust.isPending} disabled={!units || tooMany}>
          {t(direction === 'add' ? 'stock.addSubmit' : 'stock.takeSubmit', {
            count: formatCount(units ?? 0),
          })}
        </Button>
        <Button variant="tertiary" onClick={onDone}>
          {t('returns.cancel')}
        </Button>
      </div>
    </form>
  );
}

/**
 * Stock sent from this location to another of the shop's, as from a warehouse to a shop: no
 * more than is available here, so what orders are owed stays.
 */
function MoveForm({
  itemId,
  level,
  onDone,
}: {
  itemId: string;
  level: StockLevel;
  onDone: () => void;
}) {
  const { t } = useLocale();
  const shopId = useShop().id;
  const locations = useAdminQuery<LocationsData>(['locations'], LocationsQuery);
  const move = useAdminMutation<Mutated, { input: Record<string, unknown> }>(InventoryMoveMutation);
  const { problem, attempt } = useAttempt();
  const [count, setCount] = useState('');
  const [chosen, setChosen] = useState('');
  const units = parseStock(count);
  const tooMany = units !== null && units > level.available;
  if (locations.isPending) return <Loading label={t('state.loading')} />;
  if (locations.isError) return <Alert tone="danger">{errorText(locations.error, t)}</Alert>;
  const others = locations.data.locations.nodes.filter((each) => each.id !== level.location.id);
  if (others.length === 0) {
    return (
      <div className="flex flex-col items-start gap-2">
        <p className="text-secondary">{t('stock.moveNowhere')}</p>
        <Link
          to="/$shopId/settings/locations"
          params={{ shopId }}
          className="font-medium text-primary underline"
        >
          {t('stock.moveAddLocation')}
        </Link>
        <Button variant="tertiary" onClick={onDone}>
          {t('returns.cancel')}
        </Button>
      </div>
    );
  }
  const to = others.find((each) => each.id === chosen) ?? others[0]!;

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!units || tooMany) return;
    const ok = await attempt(
      async () =>
        Object.values(
          await move.mutateAsync({
            input: {
              reason: 'movement_created',
              changes: [
                {
                  inventoryItemId: itemId,
                  quantity: units,
                  from: { locationId: level.location.id, name: 'available' },
                  to: { locationId: to.id, name: 'available' },
                },
              ],
            },
          }),
        )[0]!,
    );
    if (ok) onDone();
  };

  return (
    <form onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <TextField
          label={t('stock.howMany')}
          inputMode="numeric"
          ltr
          className="w-28"
          value={count}
          error={
            count.trim() && !units
              ? t('stock.badCount')
              : tooMany
                ? t('stock.moveTooMany', { count: formatCount(level.available) })
                : null
          }
          onChange={(event) => setCount(event.target.value)}
        />
        <SelectField
          label={t('stock.moveTo')}
          value={to.id}
          options={others.map((each) => ({ value: each.id, label: each.name }))}
          onChange={setChosen}
        />
      </div>
      {problem && <Alert tone="danger">{problem}</Alert>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" busy={move.isPending} disabled={!units || tooMany}>
          {t('stock.moveSubmit', { count: formatCount(units ?? 0), location: to.name })}
        </Button>
        <Button variant="tertiary" onClick={onDone}>
          {t('returns.cancel')}
        </Button>
      </div>
    </form>
  );
}

/**
 * What a count found on the shelf, set as on hand; refused, and said so, if stock moved since it
 * was read, as an order took some.
 */
function CountForm({
  itemId,
  locationId,
  onHand,
  onDone,
}: {
  itemId: string;
  locationId: string;
  onHand: number | null;
  onDone: () => void;
}) {
  const { t } = useLocale();
  const set = useAdminMutation<Mutated, { input: Record<string, unknown> }>(
    InventorySetQuantitiesMutation,
  );
  const { problem, attempt } = useAttempt();
  const [count, setCount] = useState(onHand === null ? '' : String(onHand));
  const units = parseStock(count);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (units === null) return;
    const ok = await attempt(
      async () =>
        Object.values(
          await set.mutateAsync({
            input: {
              name: 'on_hand',
              reason: 'cycle_count_available',
              quantities: [
                {
                  inventoryItemId: itemId,
                  locationId,
                  quantity: units,
                  ...(onHand !== null && { compareQuantity: onHand }),
                },
              ],
            },
          }),
        )[0]!,
    );
    if (ok) onDone();
  };

  return (
    <form onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-3">
      <TextField
        label={t('stock.counted')}
        hint={t('stock.countedHint')}
        inputMode="numeric"
        ltr
        className="w-28"
        value={count}
        error={count.trim() && units === null ? t('stock.badCount') : null}
        onChange={(event) => setCount(event.target.value)}
      />
      {problem && <Alert tone="danger">{problem}</Alert>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" busy={set.isPending} disabled={units === null || units === onHand}>
          {t('stock.countSubmit')}
        </Button>
        <Button variant="tertiary" onClick={onDone}>
          {t('returns.cancel')}
        </Button>
      </div>
    </form>
  );
}

function Level({ itemId, level }: { itemId: string; level: StockLevel }) {
  const { t } = useLocale();
  const { role } = useShop();
  const [open, setOpen] = useState<'adjust' | 'count' | 'move' | null>(null);
  const edits = EDITS_STOCK.includes(role);
  const figures: [MessageKey, number][] = [
    ['stock.onHand', level.onHand],
    ['stock.committed', level.committed],
    ...(level.reserved > 0 ? ([['stock.reserved', level.reserved]] as [MessageKey, number][]) : []),
    ...(level.safetyStock > 0
      ? ([['stock.safetyStock', level.safetyStock]] as [MessageKey, number][])
      : []),
    ['stock.available', level.available],
  ];
  return (
    <li className="flex flex-col gap-2 py-3">
      <span className="font-medium" dir="auto">
        {level.location.name}
      </span>
      <dl className="grid grid-cols-3 gap-2 sm:grid-cols-5">
        {figures.map(([key, value]) => (
          <div key={key} className="flex flex-col">
            <dt className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
              {t(key)}
            </dt>
            <dd
              className={`num font-semibold ${
                key === 'stock.available' && value <= 0 ? 'text-danger' : ''
              }`}
            >
              {formatCount(value)}
            </dd>
          </div>
        ))}
      </dl>
      {edits && open === null && (
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => setOpen('adjust')}>
            {t('stock.adjust')}
          </Button>
          <Button variant="secondary" onClick={() => setOpen('count')}>
            {t('stock.count')}
          </Button>
          {level.available > 0 && (
            <Button variant="secondary" onClick={() => setOpen('move')}>
              {t('stock.move')}
            </Button>
          )}
        </div>
      )}
      {open === 'move' && <MoveForm itemId={itemId} level={level} onDone={() => setOpen(null)} />}
      {open === 'adjust' && (
        <AdjustForm itemId={itemId} level={level} onDone={() => setOpen(null)} />
      )}
      {open === 'count' && (
        <CountForm
          itemId={itemId}
          locationId={level.location.id}
          onHand={level.onHand}
          onDone={() => setOpen(null)}
        />
      )}
    </li>
  );
}

/** A variant's stock at each location, changed by those who may, and its history. */
function StockItem({ itemId }: { itemId: string }) {
  const { t } = useLocale();
  const { role } = useShop();
  const word = useWord();
  const [counting, setCounting] = useState(false);
  const query = useAdminQuery<InventoryItemData>(['inventoryItem', itemId], InventoryItemQuery, {
    id: itemId,
  });
  if (query.isPending) return <Loading label={t('state.loading')} />;
  if (query.isError) return <Alert tone="danger">{errorText(query.error, t)}</Alert>;
  const item = query.data.inventoryItem;
  if (!item) return <p className="text-secondary">{t('stock.gone')}</p>;
  const primary = query.data.location;

  return (
    <div className="flex flex-col gap-2">
      {item.inventoryLevels.length === 0 ? (
        <div className="flex flex-col gap-2">
          <p className="text-secondary">{t('stock.notCounted')}</p>
          {EDITS_STOCK.includes(role) &&
            primary &&
            (counting ? (
              <CountForm
                itemId={item.id}
                locationId={primary.id}
                onHand={null}
                onDone={() => setCounting(false)}
              />
            ) : (
              <Button variant="secondary" className="self-start" onClick={() => setCounting(true)}>
                {t('stock.countAt', { location: primary.name })}
              </Button>
            ))}
        </div>
      ) : (
        <ul className="flex flex-col divide-y divide-line">
          {item.inventoryLevels.map((level) => (
            <Level key={level.id} itemId={item.id} level={level} />
          ))}
        </ul>
      )}
      <StockChanges
        itemId={item.id}
        latest={item.changes}
        locations={item.inventoryLevels.map((each) => each.location)}
        word={word}
      />
    </div>
  );
}

/** A variant's row: its name and what it has for sale, opening its stock. */
function Row({
  productId,
  title,
  sku,
  barcode = null,
  itemId,
  available,
  tracked = true,
  opened = false,
  incoming = 0,
  lastFrom = null,
  chosen,
  onChoose,
}: {
  productId: string;
  title: string;
  sku: string | null;
  barcode?: string | null;
  itemId: string;
  available: number;
  tracked?: boolean;
  /** Open at first, as the one variant a barcode found. */
  opened?: boolean;
  /** Units on open purchase orders, not yet received. */
  incoming?: number;
  /** The supplier it was ordered from last. */
  lastFrom?: string | null;
  /** Chosen to order, where it can be. */
  chosen?: boolean;
  onChoose?: (chosen: boolean) => void;
}) {
  const { t } = useLocale();
  const { id: shopId } = useShop();
  const [open, setOpen] = useState(opened);
  return (
    <li className="flex flex-col gap-2 py-2">
      <div className="flex items-center justify-between gap-3">
        {onChoose && (
          <input
            type="checkbox"
            checked={chosen ?? false}
            onChange={(event) => onChoose(event.target.checked)}
            aria-label={t('stock.choose', { title })}
            className="size-5 shrink-0 accent-[var(--hatti-color-primary)]"
          />
        )}
        <span className="flex min-w-0 flex-1 flex-col">
          <Link
            to="/$shopId/products/$productId"
            params={{ shopId, productId }}
            className="font-medium text-primary hover:underline"
            dir="auto"
          >
            {title}
          </Link>
          <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
            {!tracked
              ? t('stock.untracked')
              : available <= 0
                ? t('stock.out')
                : t('stock.left', { count: formatCount(available) })}
            {incoming > 0 && ` · ${t('stock.incoming', { count: formatCount(incoming) })}`}
            {lastFrom && ` · ${t('stock.lastFrom', { name: lastFrom })}`}
            {[sku, barcode].map(
              (code) =>
                code && (
                  <span key={code}>
                    {' · '}
                    <span dir="ltr">{code}</span>
                  </span>
                ),
            )}
          </span>
        </span>
        <Button
          variant="tertiary"
          aria-expanded={open}
          aria-label={t(open ? 'stock.hide' : 'stock.show', { title })}
          icon={
            open ? (
              <ChevronUp aria-hidden className="size-5" />
            ) : (
              <ChevronDown aria-hidden className="size-5" />
            )
          }
          onClick={() => setOpen(!open)}
        />
      </div>
      {open && <StockItem itemId={itemId} />}
    </li>
  );
}

const variantTitle = (product: string, variant: string) =>
  variant && variant !== 'Default Title' ? `${product} · ${variant}` : product;

/** What the shop calls low, changed by those who change stock. */
function Threshold({ threshold }: { threshold: number }) {
  const { t } = useLocale();
  const { role } = useShop();
  const update = useAdminMutation<Mutated, { input: { lowStockThreshold: number } }>(
    InventorySettingsUpdateMutation,
  );
  const { problem, attempt } = useAttempt();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(String(threshold));
  const parsed = parseStock(value);
  const valid = parsed !== null && parsed <= 10000;

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!valid) return;
    const ok = await attempt(
      async () =>
        Object.values(await update.mutateAsync({ input: { lowStockThreshold: parsed } }))[0]!,
    );
    if (ok) setEditing(false);
  };

  if (!editing) {
    return (
      <p className="flex flex-wrap items-center gap-x-2 text-secondary">
        {t('stock.threshold', { count: formatCount(threshold) })}
        {EDITS_STOCK.includes(role) && (
          <Button
            variant="tertiary"
            onClick={() => {
              setValue(String(threshold));
              setEditing(true);
            }}
          >
            {t('stock.thresholdChange')}
          </Button>
        )}
      </p>
    );
  }
  return (
    <form onSubmit={(event) => void onSubmit(event)} className="flex flex-wrap items-end gap-2">
      <TextField
        label={t('stock.thresholdLabel')}
        inputMode="numeric"
        ltr
        className="w-28"
        value={value}
        error={value.trim() && !valid ? t('stock.badThreshold') : null}
        onChange={(event) => setValue(event.target.value)}
      />
      <Button type="submit" busy={update.isPending} disabled={!valid}>
        {t('stock.thresholdSave')}
      </Button>
      <Button variant="tertiary" onClick={() => setEditing(false)}>
        {t('returns.cancel')}
      </Button>
      {problem && <Alert tone="danger">{problem}</Alert>}
    </form>
  );
}

/** Digits alone, as a barcode on goods reads (EAN, UPC), or typed by a scanner at the keyboard. */
const BARCODE = /^\d{6,14}$/;

interface Search {
  query: string;
  /** The barcode searched for, whose variants alone are shown. */
  barcode: string | null;
}

/** A search for the variants with `code` as their barcode, in the core's search syntax. */
function byBarcode(code: string): Search {
  return { query: `barcode:"${code.replace(/["\\]/g, '')}"`, barcode: code };
}

/**
 * Products found by words, each variant's stock a tap away; or the variant with a barcode, typed,
 * scanned with the phone's camera, or by a scanner that types it, opened at once.
 */
function FindStock() {
  const { t } = useLocale();
  const [words, setWords] = useState('');
  const [searched, setSearched] = useState<Search | null>(null);
  const [scanning, setScanning] = useState(false);
  const query = useAdminQuery<StockSearchData>(
    ['stockSearch', searched?.query ?? null],
    StockSearchQuery,
    { query: searched?.query ?? null },
    { enabled: searched !== null },
  );
  const code = searched?.barcode?.toLowerCase() ?? null;
  const found = (query.data?.products.nodes ?? []).flatMap((product) =>
    product.variants
      .filter((variant) => code === null || variant.barcode?.toLowerCase() === code)
      .map((variant) => ({ product, variant })),
  );
  return (
    <div className="flex flex-col gap-3">
      <form
        role="search"
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const typed = words.trim();
          setSearched(BARCODE.test(typed) ? byBarcode(typed) : { query: typed, barcode: null });
        }}
      >
        <input
          type="search"
          value={words}
          onChange={(event) => setWords(event.target.value)}
          aria-label={t('stock.findWords')}
          placeholder={t('stock.findWords')}
          className="min-h-12 min-w-0 flex-1 rounded-control border border-line bg-surface px-3 md:min-h-10"
        />
        <Button type="submit" variant="secondary" icon={<Search aria-hidden className="size-5" />}>
          {t('drafts.find')}
        </Button>
      </form>
      {canScan() &&
        (scanning ? (
          <Scanner
            onCode={(scanned) => {
              setScanning(false);
              setWords(scanned);
              setSearched(byBarcode(scanned));
            }}
            onClose={() => setScanning(false)}
          />
        ) : (
          <Button
            variant="secondary"
            className="self-start"
            icon={<ScanBarcode aria-hidden className="size-5" />}
            onClick={() => setScanning(true)}
          >
            {t('stock.scan')}
          </Button>
        ))}
      {query.isError && <Alert tone="danger">{errorText(query.error, t)}</Alert>}
      {query.data &&
        (found.length === 0 ? (
          <p className="text-secondary">
            {searched?.barcode
              ? t('stock.barcodeNone', { barcode: searched.barcode })
              : t('drafts.noProducts')}
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-line">
            {found.map(({ product, variant }) => (
              <Row
                key={`${searched?.query}:${variant.id}`}
                productId={product.id}
                title={variantTitle(product.title, variant.title)}
                sku={variant.sku}
                barcode={variant.barcode}
                itemId={variant.inventoryItem.id}
                available={variant.inventoryQuantity}
                tracked={variant.inventoryItem.tracked}
                opened={code !== null && found.length === 1}
              />
            ))}
          </ul>
        ))}
    </div>
  );
}

/**
 * Stock (INV-01): what runs low or out, the fewest for sale first, and any product's stock found
 * by its name; each variant's stock at each location, added to or taken from with a reason and
 * counted by owners and managers, with its latest changes. Every role sees it.
 */
export function StockPage() {
  const { t } = useLocale();
  const { id: shopId, role } = useShop();
  const navigate = useNavigate();
  const query = useAdminQuery<LowStockData>(['lowStock'], LowStockQuery);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const edits = EDITS_STOCK.includes(role);
  const low = query.data?.inventoryLowStock.nodes ?? [];
  const choose = (variantId: string, on: boolean) =>
    setChosen((now) => {
      const next = new Set(now);
      if (on) next.add(variantId);
      else next.delete(variantId);
      return next;
    });

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-[length:var(--hatti-type-display-size)] font-semibold">
          {t('stock.title')}
        </h1>
        <div className="flex flex-wrap gap-2">
          <Link
            to="/$shopId/purchase-orders"
            params={{ shopId }}
            className="inline-flex min-h-12 items-center gap-2 rounded-control border border-line bg-surface px-4 font-medium hover:bg-canvas md:min-h-10"
          >
            <Truck aria-hidden className="size-5" />
            {t('po.title')}
          </Link>
          {EDITS_STOCK.includes(role) && (
            <Link
              to="/$shopId/products/files"
              params={{ shopId }}
              className="inline-flex min-h-12 items-center gap-2 rounded-control border border-line bg-surface px-4 font-medium hover:bg-canvas md:min-h-10"
            >
              <FileSpreadsheet aria-hidden className="size-5" />
              {t('files.countByFile')}
            </Link>
          )}
        </div>
      </div>
      {query.isPending ? (
        <Loading label={t('state.loading')} />
      ) : query.isError ? (
        <ErrorState
          message={errorText(query.error, t)}
          action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
        />
      ) : (
        <Section title={t('stock.low')}>
          <Threshold threshold={query.data.inventorySettings.lowStockThreshold} />
          {query.data.inventoryLowStock.nodes.length === 0 ? (
            <EmptyState title={t('stock.noneLow')} />
          ) : (
            <>
              <ul className="flex flex-col divide-y divide-line">
                {low.map((each) => (
                  <Row
                    key={each.variantId}
                    productId={each.productId}
                    title={variantTitle(each.productTitle, each.variantTitle)}
                    sku={each.sku}
                    itemId={each.inventoryItem.id}
                    available={each.available}
                    incoming={each.incoming}
                    lastFrom={each.lastSupplier?.name ?? null}
                    chosen={chosen.has(each.variantId)}
                    onChoose={edits ? (on) => choose(each.variantId, on) : undefined}
                  />
                ))}
              </ul>
              {edits && (
                <div className="flex flex-wrap gap-2">
                  <Button
                    disabled={chosen.size === 0}
                    icon={<Truck aria-hidden className="size-5" />}
                    onClick={() =>
                      void navigate({
                        to: '/$shopId/purchase-orders/new',
                        params: { shopId },
                        search: {
                          variants: low
                            .filter((each) => chosen.has(each.variantId))
                            .map((each) => each.variantId)
                            .join(','),
                        },
                      })
                    }
                  >
                    {t('stock.orderChosen', { count: formatCount(chosen.size) })}
                  </Button>
                  {chosen.size < low.length && (
                    <Button
                      variant="tertiary"
                      onClick={() => setChosen(new Set(low.map((each) => each.variantId)))}
                    >
                      {t('stock.chooseAll')}
                    </Button>
                  )}
                </div>
              )}
            </>
          )}
        </Section>
      )}
      <Section title={t('stock.find')}>
        <FindStock />
      </Section>
      {edits && (
        <Section title={t('stock.countScan.title')}>
          <StockCount />
        </Section>
      )}
    </div>
  );
}
