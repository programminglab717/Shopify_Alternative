import { ScanBarcode, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import {
  InventorySetQuantitiesMutation,
  LocationsQuery,
  StockCountFindQuery,
} from '../api/operations';
import type { LocationsData, StockCountFindData, UserError } from '../api/types';
import { useSessionStore } from '../auth/context';
import { errorText } from '../i18n/errors';
import { formatCount } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import { parseStock } from '../products/product-form';
import { SelectField } from '../settings/settings-form';
import { useAdminMutation, useAdminQuery, useShop } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, Loading } from '../ui/feedback';
import { Scanner, canScan } from './scanner';

/** A variant counted: what was on hand when it was first scanned, and what the count found. */
interface Line {
  itemId: string;
  title: string;
  /** The barcode or SKU it was found by, which finds it again in the list. */
  codes: string[];
  /** On hand at the location when read; 0 where it was never stocked, as the core reads it. */
  was: number;
  counted: string;
  /** On hand moved since it was read: read again, to be checked before saving. */
  changed: boolean;
}

type Mutated = Record<string, { userErrors: UserError[] }>;

const variantTitle = (product: string, variant: string) =>
  variant && variant !== 'Default Title' ? `${product} · ${variant}` : product;

/** A search for exactly `code` as a barcode, then as a SKU, in the core's search syntax. */
const searchesFor = (code: string) => {
  const quoted = `"${code.replace(/["\\]/g, '')}"`;
  return [`barcode:${quoted}`, `sku:${quoted}`];
};

/**
 * A stock count at one location by scanning (INV-07): each barcode scanned, or barcode or SKU
 * typed, adds its variant or one more of it; the counts can be corrected, and are saved together,
 * each against what was on hand when it was read. Those that moved since are read again and said.
 */
export function StockCount() {
  const { t } = useLocale();
  const shop = useShop();
  const store = useSessionStore();
  const locations = useAdminQuery<LocationsData>(['locations'], LocationsQuery);
  const save = useAdminMutation<Mutated, { input: Record<string, unknown> }>(
    InventorySetQuantitiesMutation,
  );
  const [started, setStarted] = useState(false);
  const [chosen, setChosen] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [code, setCode] = useState('');
  const [scanning, setScanning] = useState(false);
  const [looking, setLooking] = useState(false);
  const [said, setSaid] = useState<{ tone: 'danger' | 'success'; text: string } | null>(null);

  if (!started) {
    return (
      <div className="flex flex-col items-start gap-2">
        <p className="text-secondary">{t('stock.countScan.about')}</p>
        <Button variant="secondary" onClick={() => setStarted(true)}>
          {t('stock.countScan.start')}
        </Button>
      </div>
    );
  }
  if (locations.isPending) return <Loading label={t('state.loading')} />;
  if (locations.isError) return <Alert tone="danger">{errorText(locations.error, t)}</Alert>;
  const places = locations.data.locations.nodes;
  const location =
    places.find((each) => each.id === chosen) ?? places.find((each) => each.isPrimary) ?? places[0];
  if (!location) return <p className="text-secondary">{t('stock.moveNowhere')}</p>;

  /** On hand of the variants with `codes`, found by the first search that finds one. */
  const find = async (wanted: string) => {
    for (const query of searchesFor(wanted)) {
      const data = await store.graphql<StockCountFindData>(shop.id, StockCountFindQuery, {
        query,
        locationId: location.id,
      });
      const lower = wanted.toLowerCase();
      for (const product of data.products.nodes) {
        const variant = product.variants.find(
          (each) => each.barcode?.toLowerCase() === lower || each.sku?.toLowerCase() === lower,
        );
        if (variant) {
          return {
            itemId: variant.inventoryItem.id,
            title: variantTitle(product.title, variant.title),
            was: variant.inventoryItem.inventoryLevel?.onHand ?? 0,
          };
        }
      }
    }
    return null;
  };

  const add = async (raw: string) => {
    const wanted = raw.trim();
    if (!wanted) return;
    setSaid(null);
    const lower = wanted.toLowerCase();
    const known = lines.findIndex((line) => line.codes.includes(lower));
    if (known >= 0) {
      // One more of what was scanned before.
      setLines((now) =>
        now.map((line, index) =>
          index === known
            ? { ...line, counted: String((parseStock(line.counted) ?? 0) + 1) }
            : line,
        ),
      );
      setCode('');
      return;
    }
    setLooking(true);
    try {
      const found = await find(wanted);
      if (!found) {
        setSaid({ tone: 'danger', text: t('stock.countScan.none', { code: wanted }) });
        return;
      }
      setLines((now) => {
        const same = now.findIndex((line) => line.itemId === found.itemId);
        if (same >= 0) {
          // Its barcode, after its SKU, or the other way about.
          return now.map((line, index) =>
            index === same
              ? {
                  ...line,
                  codes: [...line.codes, lower],
                  counted: String((parseStock(line.counted) ?? 0) + 1),
                }
              : line,
          );
        }
        return [{ ...found, codes: [lower], counted: '1', changed: false }, ...now];
      });
      setCode('');
    } catch (error) {
      setSaid({ tone: 'danger', text: errorText(error, t) });
    } finally {
      setLooking(false);
    }
  };

  const valid = lines.length > 0 && lines.every((line) => parseStock(line.counted) !== null);

  const onSave = async () => {
    if (!valid) return;
    setSaid(null);
    try {
      const payload = Object.values(
        await save.mutateAsync({
          input: {
            name: 'on_hand',
            reason: 'cycle_count_available',
            quantities: lines.map((line) => ({
              inventoryItemId: line.itemId,
              locationId: location.id,
              quantity: parseStock(line.counted),
              compareQuantity: line.was,
            })),
          },
        }),
      )[0]!;
      const stale = payload.userErrors
        .filter((error) => error.code === 'STALE')
        .map((error) => Number(error.field?.[2]));
      if (stale.length > 0) {
        // Read again what moved, as an order or another count took some, to check before saving.
        const fresh = await Promise.all(
          stale.map(async (index) => [index, await find(lines[index]!.codes[0]!)] as const),
        );
        setLines((now) =>
          now.map((line, index) => {
            const again = fresh.find(([at]) => at === index)?.[1];
            return again ? { ...line, was: again.was, changed: true } : line;
          }),
        );
        setSaid({
          tone: 'danger',
          text: t('stock.countScan.stale', { count: String(stale.length) }),
        });
        return;
      }
      if (payload.userErrors.length > 0) {
        setSaid({ tone: 'danger', text: payload.userErrors[0]!.message });
        return;
      }
      setSaid({
        tone: 'success',
        text: t('stock.countScan.saved', {
          count: String(lines.length),
          location: location.name,
        }),
      });
      setLines([]);
    } catch (error) {
      setSaid({ tone: 'danger', text: errorText(error, t) });
    }
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    void add(code);
  };

  return (
    <div className="flex flex-col gap-3">
      {places.length > 1 &&
        (lines.length === 0 ? (
          <SelectField
            label={t('stock.countScan.where')}
            value={location.id}
            options={places.map((each) => ({ value: each.id, label: each.name }))}
            onChange={setChosen}
          />
        ) : (
          <p>{t('stock.countScan.at', { location: location.name })}</p>
        ))}
      <form onSubmit={onSubmit} className="flex gap-2">
        <input
          value={code}
          onChange={(event) => setCode(event.target.value)}
          aria-label={t('stock.countScan.code')}
          placeholder={t('stock.countScan.code')}
          dir="ltr"
          autoComplete="off"
          className="min-h-12 min-w-0 flex-1 rounded-control border border-line bg-surface px-3 md:min-h-10"
        />
        <Button type="submit" variant="secondary" busy={looking} disabled={!code.trim()}>
          {t('stock.countScan.add')}
        </Button>
      </form>
      {canScan() &&
        (scanning ? (
          <Scanner
            continuous
            onCode={(read) => void add(read)}
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
      {said && <Alert tone={said.tone}>{said.text}</Alert>}
      {lines.length > 0 && (
        <>
          <ul className="flex flex-col divide-y divide-line">
            {lines.map((line, index) => (
              <li key={line.itemId} className="flex flex-wrap items-end gap-3 py-2">
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="font-medium" dir="auto">
                    {line.title}
                  </span>
                  <span
                    className={`text-[length:var(--hatti-type-body-sm-size)] ${
                      line.changed ? 'text-danger' : 'text-secondary'
                    }`}
                  >
                    {t(line.changed ? 'stock.countScan.changed' : 'stock.countScan.was', {
                      count: formatCount(line.was),
                    })}
                  </span>
                </span>
                <label className="flex flex-col gap-1">
                  <span className="text-[length:var(--hatti-type-body-sm-size)]">
                    {t('stock.countScan.counted', { title: line.title })}
                  </span>
                  <input
                    value={line.counted}
                    inputMode="numeric"
                    dir="ltr"
                    aria-invalid={parseStock(line.counted) === null || undefined}
                    onChange={(event) =>
                      setLines((now) =>
                        now.map((each, at) =>
                          at === index ? { ...each, counted: event.target.value } : each,
                        ),
                      )
                    }
                    className="min-h-12 w-24 rounded-control border border-line bg-surface px-3 md:min-h-10"
                  />
                </label>
                <Button
                  variant="tertiary"
                  aria-label={t('stock.countScan.remove', { title: line.title })}
                  icon={<Trash2 aria-hidden className="size-5" />}
                  onClick={() => setLines((now) => now.filter((_, at) => at !== index))}
                />
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2">
            <Button busy={save.isPending} disabled={!valid} onClick={() => void onSave()}>
              {t('stock.countScan.save', { count: String(lines.length) })}
            </Button>
            <Button variant="tertiary" onClick={() => setLines([])}>
              {t('stock.countScan.clear')}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
