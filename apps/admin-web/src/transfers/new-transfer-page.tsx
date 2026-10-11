import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { ArrowLeft, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import {
  InventoryTransferCreateMutation,
  LocationsQuery,
  LowStockToSendQuery,
} from '../api/operations';
import type { LocationsData, LowStockToSendData, UserError } from '../api/types';
import { formatCount } from '../i18n/format';
import { errorText } from '../i18n/errors';
import { useLocale } from '../i18n/locale';
import { parseStock } from '../products/product-form';
import { FindVariants, type Line } from '../purchase-orders/new-purchase-order-page';
import { useAttempt } from '../returns/parcel';
import { SelectField } from '../settings/settings-form';
import { useAdminMutation, useAdminQuery, useShop } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, Card, EmptyState, ErrorState, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';

export interface NewTransferSearch {
  /** Variants running low at `to`, chosen on the stock page, comma-separated. */
  variants?: string;
  /** The location they run low at, where the stock goes. */
  to?: string;
}

export function validateNewTransferSearch(search: Record<string, unknown>): NewTransferSearch {
  return {
    variants: typeof search.variants === 'string' ? search.variants : undefined,
    to: typeof search.to === 'string' ? search.to : undefined,
  };
}

/** What a transfer starts with, when sending what runs low at a location. */
export interface TransferStart {
  originId: string;
  lines: Line[];
  /** Chosen variants the origin has none of to send. */
  missing: number;
}

const variantTitle = (product: string, variant: string) =>
  variant && variant !== 'Default Title' ? `${product} · ${variant}` : product;

/**
 * Sending what runs low at `to` (ADR-361): of each chosen variant, enough for twice the shop's low
 * mark, less what it has and what is on its way, as a purchase order from what runs low is; from
 * the other location that can send the most of it, and no more than that location has.
 */
export function startFromLow(
  low: LowStockToSendData,
  variantIds: readonly string[],
  to: string,
  locations: readonly { id: string; isPrimary: boolean }[],
): TransferStart | null {
  const threshold = low.inventorySettings.lowStockThreshold;
  const chosen = low.inventoryLowStock.nodes.filter((each) => variantIds.includes(each.variantId));
  if (chosen.length === 0) return null;
  const want = (each: (typeof chosen)[number]) =>
    Math.max(1, threshold * 2 - each.available - each.incoming);
  const at = (each: (typeof chosen)[number], locationId: string) =>
    Math.max(
      0,
      each.inventoryItem.inventoryLevels.find((level) => level.location.id === locationId)
        ?.available ?? 0,
    );
  const others = locations.filter((each) => each.id !== to);
  const sendable = (locationId: string) =>
    chosen.reduce((sum, each) => sum + Math.min(want(each), at(each, locationId)), 0);
  // The most it can send; a tie goes to the primary, then the first listed.
  const origin = [...others].sort(
    (x, y) => sendable(y.id) - sendable(x.id) || Number(y.isPrimary) - Number(x.isPrimary),
  )[0];
  if (!origin) return null;
  const lines = chosen
    .filter((each) => at(each, origin.id) > 0)
    .map((each) => ({
      itemId: each.inventoryItem.id,
      title: variantTitle(each.productTitle, each.variantTitle),
      quantity: String(Math.min(want(each), at(each, origin.id))),
      unitCost: '',
    }));
  return { originId: origin.id, lines, missing: chosen.length - lines.length };
}

type Created = Record<
  'inventoryTransferCreate',
  { inventoryTransfer: { id: string } | null; userErrors: UserError[] }
>;

/**
 * Stock sent to another location (INV-04, ADR-360): where it leaves and where it goes, the
 * courier's number, and what of it, each taken off on hand where it leaves.
 */
export function NewTransferPage() {
  const { t } = useLocale();
  const { id: shopId } = useShop();
  const { variants, to } = useSearch({ from: '/$shopId/transfers/new' });
  const chosen = variants?.split(',').filter(Boolean) ?? [];
  const fromLow = chosen.length > 0 && to !== undefined;
  const places = useAdminQuery<LocationsData>(['locations'], LocationsQuery);
  // As the stock page listed them, for the location they run low at (ADR-359).
  const low = useAdminQuery<LowStockToSendData>(
    ['lowStockToSend'],
    LowStockToSendQuery,
    { locationId: to ?? null },
    { enabled: fromLow },
  );
  const back = (
    <Link
      to="/$shopId/transfers"
      params={{ shopId }}
      className="inline-flex min-h-10 items-center gap-1 self-start text-secondary hover:text-text"
    >
      <ArrowLeft aria-hidden className="size-5 rtl:rotate-180" />
      {t('transfers.title')}
    </Link>
  );
  if (places.isPending || (fromLow && low.isPending)) {
    return <Loading label={t('state.loading')} />;
  }
  if (places.isError) return <ErrorState message={errorText(places.error, t)} />;
  if (low.isError) return <ErrorState message={errorText(low.error, t)} />;
  const locations = places.data.locations.nodes;
  if (locations.length < 2) {
    return (
      <div className="mx-auto flex max-w-3xl flex-col gap-4">
        {back}
        <EmptyState
          title={t('transfers.oneLocation')}
          action={
            <Link
              to="/$shopId/settings/locations"
              params={{ shopId }}
              className="font-medium text-primary underline"
            >
              {t('stock.moveAddLocation')}
            </Link>
          }
        />
      </div>
    );
  }
  const goesTo = locations.some((each) => each.id === to) ? to : undefined;
  return (
    <SendForm
      locations={locations}
      back={back}
      to={goesTo}
      start={goesTo && low.data ? startFromLow(low.data, chosen, goesTo, locations) : null}
    />
  );
}

function SendForm({
  locations,
  back,
  to,
  start,
}: {
  locations: LocationsData['locations']['nodes'];
  back: ReactNode;
  to: string | undefined;
  start: TransferStart | null;
}) {
  const { t } = useLocale();
  const { id: shopId } = useShop();
  const navigate = useNavigate();
  const create = useAdminMutation<Created, { input: Record<string, unknown> }>(
    InventoryTransferCreateMutation,
  );
  const { problem, attempt } = useAttempt();
  const primary = locations.find((each) => each.isPrimary) ?? locations[0]!;
  const from = start?.originId ?? (to === primary.id ? undefined : primary.id);
  const [origin, setOrigin] = useState(from ?? locations.find((each) => each.id !== to)!.id);
  const [destination, setDestination] = useState(
    to ?? locations.find((each) => each.id !== origin)!.id,
  );
  const [reference, setReference] = useState('');
  const [lines, setLines] = useState<Line[]>(start?.lines ?? []);
  const nameOf = (id: string) => locations.find((each) => each.id === id)?.name ?? '';
  const valid =
    origin !== destination &&
    lines.length > 0 &&
    lines.every((line) => (parseStock(line.quantity) ?? 0) > 0);
  const change = (index: number, quantity: string) =>
    setLines((now) => now.map((line, at) => (at === index ? { ...line, quantity } : line)));

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!valid) return;
    let id: string | null = null;
    const ok = await attempt(async () => {
      const { inventoryTransferCreate } = await create.mutateAsync({
        input: {
          originId: origin,
          destinationId: destination,
          reference: reference.trim() || null,
          lines: lines.map((line) => ({
            inventoryItemId: line.itemId,
            quantity: parseStock(line.quantity),
          })),
        },
      });
      id = inventoryTransferCreate.inventoryTransfer?.id ?? null;
      return inventoryTransferCreate;
    });
    if (ok && id) {
      void navigate({
        to: '/$shopId/transfers/$transferId',
        params: { shopId, transferId: id },
      });
    }
  };

  const options = locations.map((each) => ({ value: each.id, label: each.name }));
  return (
    <form
      onSubmit={(event) => void onSubmit(event)}
      className="mx-auto flex max-w-3xl flex-col gap-4"
    >
      {back}
      <h1 className="text-[length:var(--hatti-type-display-size)] font-semibold">
        {t('transfers.new')}
      </h1>
      <Card className="flex flex-col gap-3 p-4">
        <div className="flex flex-wrap gap-3">
          <SelectField
            label={t('transfers.from')}
            value={origin}
            options={options}
            onChange={setOrigin}
          />
          <SelectField
            label={t('transfers.to')}
            value={destination}
            options={options}
            onChange={setDestination}
          />
        </div>
        {origin === destination && <Alert tone="danger">{t('transfers.sameLocation')}</Alert>}
        <TextField
          label={t('transfers.reference')}
          hint={t('transfers.referenceHint')}
          value={reference}
          onChange={(event) => setReference(event.target.value)}
        />
      </Card>
      <Card className="flex flex-col gap-3 p-4">
        <h2 className="font-semibold">{t('po.lines')}</h2>
        {start && (
          <p className="text-secondary">
            {t('transfers.fromLow', {
              to: nameOf(destination),
              from: nameOf(start.originId),
            })}
          </p>
        )}
        {start && start.missing > 0 && (
          <Alert tone="warning">
            {t('transfers.missing', {
              count: formatCount(start.missing),
              from: nameOf(start.originId),
            })}
          </Alert>
        )}
        <FindVariants
          chosen={new Set(lines.map((line) => line.itemId))}
          onAdd={(line) => setLines((now) => [...now, line])}
          findLabel={t('transfers.findProducts')}
          addLabel={(title) => t('transfers.addLine', { title })}
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
                  onChange={(event) => change(index, event.target.value)}
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
      <p className="text-secondary">{t('transfers.sendAbout')}</p>
      {problem && <Alert tone="danger">{problem}</Alert>}
      <Button type="submit" className="self-start" busy={create.isPending} disabled={!valid}>
        {t('transfers.send')}
      </Button>
    </form>
  );
}
