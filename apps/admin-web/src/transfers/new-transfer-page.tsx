import { Link, useNavigate } from '@tanstack/react-router';
import { ArrowLeft, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { InventoryTransferCreateMutation, LocationsQuery } from '../api/operations';
import type { LocationsData, UserError } from '../api/types';
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
  const places = useAdminQuery<LocationsData>(['locations'], LocationsQuery);
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
  if (places.isPending) return <Loading label={t('state.loading')} />;
  if (places.isError) return <ErrorState message={errorText(places.error, t)} />;
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
  return <SendForm locations={locations} back={back} />;
}

function SendForm({
  locations,
  back,
}: {
  locations: LocationsData['locations']['nodes'];
  back: ReactNode;
}) {
  const { t } = useLocale();
  const { id: shopId } = useShop();
  const navigate = useNavigate();
  const create = useAdminMutation<Created, { input: Record<string, unknown> }>(
    InventoryTransferCreateMutation,
  );
  const { problem, attempt } = useAttempt();
  const primary = locations.find((each) => each.isPrimary) ?? locations[0]!;
  const [origin, setOrigin] = useState(primary.id);
  const [destination, setDestination] = useState(
    locations.find((each) => each.id !== primary.id)!.id,
  );
  const [reference, setReference] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
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
