import { ScanBarcode } from 'lucide-react';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { StockCountFindQuery } from '../api/operations';
import type { StockCountFindData } from '../api/types';
import { useSessionStore } from '../auth/context';
import { errorText } from '../i18n/errors';
import { useLocale } from '../i18n/locale';
import { useShop } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert } from '../ui/feedback';
import { Scanner, canScan } from './scanner';

/**
 * Goods counted one box at a time (ADR-363): a barcode or SKU typed, or read by a scanner at the
 * keyboard or the phone's camera, found among the shop's variants and handed to `onItem` as one
 * more of its line; a code no line has is said so. Used where goods arrive, a purchase order's
 * and a transfer's, and where an order is packed (ADR-373).
 */
export function CountByCode({
  locationId,
  onItem,
  notOnList,
  children,
}: {
  /** Where the goods arrive, whose stock the search reads. */
  locationId: string;
  /** One more of the line with this item, the variant's too; false where no line has it. */
  onItem: (itemId: string, variantId: string) => boolean;
  /** What is said of a code no line has. */
  notOnList: (code: string) => string;
  /** Beside the code's field, such as filling in all that is to come. */
  children?: ReactNode;
}) {
  const { t } = useLocale();
  const shop = useShop();
  const store = useSessionStore();
  const [code, setCode] = useState('');
  const [scanning, setScanning] = useState(false);
  const [said, setSaid] = useState<string | null>(null);

  /** One more of the line whose variant has `wanted` as its barcode or SKU. */
  const scanned = async (wanted: string) => {
    setSaid(null);
    const quoted = `"${wanted.replace(/["\\]/g, '')}"`;
    let itemId: string | null = null;
    let variantId = '';
    try {
      for (const query of [`barcode:${quoted}`, `sku:${quoted}`]) {
        const data = await store.graphql<StockCountFindData>(shop.id, StockCountFindQuery, {
          query,
          locationId,
        });
        const lower = wanted.toLowerCase();
        const variant = data.products.nodes
          .flatMap((product) => product.variants)
          .find(
            (each) => each.barcode?.toLowerCase() === lower || each.sku?.toLowerCase() === lower,
          );
        if (variant) {
          itemId = variant.inventoryItem.id;
          variantId = variant.id;
          break;
        }
      }
    } catch (error) {
      setSaid(errorText(error, t));
      return;
    }
    if (!itemId || !onItem(itemId, variantId)) {
      setSaid(notOnList(wanted));
      return;
    }
    setCode('');
  };

  return (
    <>
      <div className="flex flex-wrap gap-2">
        <form
          className="flex min-w-0 flex-1 gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (code.trim()) void scanned(code.trim());
          }}
        >
          <input
            value={code}
            onChange={(event) => setCode(event.target.value)}
            aria-label={t('stock.countScan.code')}
            placeholder={t('stock.countScan.code')}
            dir="ltr"
            autoComplete="off"
            className="min-h-12 min-w-0 flex-1 rounded-control border border-line bg-surface px-3 md:min-h-10"
          />
          <Button type="submit" variant="secondary" disabled={!code.trim()}>
            {t('stock.countScan.add')}
          </Button>
        </form>
        {children}
      </div>
      {canScan() &&
        (scanning ? (
          <Scanner
            continuous
            onCode={(read) => void scanned(read)}
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
      {said && <Alert tone="danger">{said}</Alert>}
    </>
  );
}
