import { Link } from '@tanstack/react-router';
import { ChevronDown, ChevronUp, Search } from 'lucide-react';
import { useId, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import {
  InventoryAdjustMutation,
  InventoryItemQuery,
  InventorySetQuantitiesMutation,
  InventorySettingsUpdateMutation,
  LowStockQuery,
  StockSearchQuery,
} from '../api/operations';
import type {
  InventoryItemData,
  LowStockData,
  StockLevel,
  StockSearchData,
  UserError,
} from '../api/types';
import type { StaffRole } from '../auth/session';
import { errorText } from '../i18n/errors';
import { formatCount, formatDateTime } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import { messages } from '../i18n/messages';
import type { MessageKey } from '../i18n/messages';
import { parseStock } from '../products/product-form';
import { useAttempt } from '../returns/parcel';
import { SelectField } from '../settings/settings-form';
import { useAdminMutation, useAdminQuery, useShop, useShopTimezone } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, Card, EmptyState, ErrorState, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';

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
  const [open, setOpen] = useState<'adjust' | 'count' | null>(null);
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
        </div>
      )}
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

/** A variant's stock at each location, changed by those who may, and its latest changes. */
function StockItem({ itemId }: { itemId: string }) {
  const { t, locale } = useLocale();
  const { role } = useShop();
  const timezone = useShopTimezone();
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
      {item.changes.nodes.length > 0 && (
        <div className="flex flex-col gap-1 border-t border-line pt-3">
          <h3 className="font-medium">{t('stock.changes')}</h3>
          <ul className="flex flex-col gap-1">
            {item.changes.nodes.map((change, index) => (
              <li
                key={`${change.createdAt}-${index}`}
                className="flex flex-wrap justify-between gap-x-3 text-[length:var(--hatti-type-body-sm-size)]"
              >
                <span>
                  <span className={`num font-medium ${change.delta < 0 ? 'text-danger' : ''}`}>
                    {change.delta > 0 ? `+${formatCount(change.delta)}` : formatCount(change.delta)}
                  </span>{' '}
                  {word('name', change.name)} · {word('reason', change.reason)}
                  {item.inventoryLevels.length > 1 && (
                    <>
                      {' · '}
                      <span dir="auto">{change.location.name}</span>
                    </>
                  )}
                </span>
                <span className="text-secondary">
                  {formatDateTime(change.createdAt, timezone, locale)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** A variant's row: its name and what it has for sale, opening its stock. */
function Row({
  productId,
  title,
  sku,
  itemId,
  available,
  tracked = true,
}: {
  productId: string;
  title: string;
  sku: string | null;
  itemId: string;
  available: number;
  tracked?: boolean;
}) {
  const { t } = useLocale();
  const { id: shopId } = useShop();
  const [open, setOpen] = useState(false);
  return (
    <li className="flex flex-col gap-2 py-2">
      <div className="flex items-center justify-between gap-3">
        <span className="flex min-w-0 flex-col">
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
            {sku && (
              <>
                {' · '}
                <span dir="ltr">{sku}</span>
              </>
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

/** Products found by words, each variant's stock a tap away. */
function FindStock() {
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
    <div className="flex flex-col gap-3">
      <form
        role="search"
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setSearched(words.trim());
        }}
      >
        <input
          type="search"
          value={words}
          onChange={(event) => setWords(event.target.value)}
          aria-label={t('drafts.findProducts')}
          placeholder={t('drafts.findProducts')}
          className="min-h-12 min-w-0 flex-1 rounded-control border border-line bg-surface px-3 md:min-h-10"
        />
        <Button type="submit" variant="secondary" icon={<Search aria-hidden className="size-5" />}>
          {t('drafts.find')}
        </Button>
      </form>
      {query.isError && <Alert tone="danger">{errorText(query.error, t)}</Alert>}
      {query.data &&
        (query.data.products.nodes.length === 0 ? (
          <p className="text-secondary">{t('drafts.noProducts')}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-line">
            {query.data.products.nodes.flatMap((product) =>
              product.variants.map((variant) => (
                <Row
                  key={variant.id}
                  productId={product.id}
                  title={variantTitle(product.title, variant.title)}
                  sku={variant.sku}
                  itemId={variant.inventoryItem.id}
                  available={variant.inventoryQuantity}
                  tracked={variant.inventoryItem.tracked}
                />
              )),
            )}
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
  const query = useAdminQuery<LowStockData>(['lowStock'], LowStockQuery);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <h1 className="text-[length:var(--hatti-type-display-size)] font-semibold">
        {t('stock.title')}
      </h1>
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
            <ul className="flex flex-col divide-y divide-line">
              {query.data.inventoryLowStock.nodes.map((each) => (
                <Row
                  key={each.variantId}
                  productId={each.productId}
                  title={variantTitle(each.productTitle, each.variantTitle)}
                  sku={each.sku}
                  itemId={each.inventoryItem.id}
                  available={each.available}
                />
              ))}
            </ul>
          )}
        </Section>
      )}
      <Section title={t('stock.find')}>
        <FindStock />
      </Section>
    </div>
  );
}
