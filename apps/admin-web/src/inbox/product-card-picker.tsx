import { ShoppingBag } from 'lucide-react';
import { useState } from 'react';
import { ProductCardSearchQuery } from '../api/operations';
import type { MoneyValue } from '../api/types';
import { gate, permits } from '../auth/permissions';
import { errorText } from '../i18n/errors';
import { formatMoney } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import { useAdminQuery, useShop } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Card } from '../ui/feedback';
import { TextField } from '../ui/field';

/** Who puts the shop's products in answers: those who answer and may read the catalog. */
export const PUTS_PRODUCTS = gate(['owner', 'manager', 'confirmation_agent'], 'read_products');

interface ProductCardSearchData {
  shop: { url: string };
  products: {
    nodes: {
      id: string;
      title: string;
      handle: string;
      status: string;
      priceRange: { minVariantPrice: MoneyValue; maxVariantPrice: MoneyValue };
    }[];
  };
}

/** A product's price as an answer says it: one price, or the lowest and highest. */
function priceText(
  range: ProductCardSearchData['products']['nodes'][number]['priceRange'],
): string {
  const low = formatMoney(range.minVariantPrice.amount, range.minVariantPrice.currencyCode);
  const high = formatMoney(range.maxVariantPrice.amount, range.maxVariantPrice.currencyCode);
  return low === high ? low : `${low} – ${high}`;
}

/**
 * A product put in an answer (MSG-08, ADR-766): its name, price and link on the storefront, whose
 * page WhatsApp previews with the product's photo. Only products on sale are offered: a draft's
 * page is not found by the customer.
 */
export function ProductCardPicker({ onPick }: { onPick: (text: string) => void }) {
  const { t } = useLocale();
  const shop = useShop();
  const [open, setOpen] = useState(false);
  const [words, setWords] = useState('');
  const query = words.trim();
  const found = useAdminQuery<ProductCardSearchData>(
    ['productCards', query],
    ProductCardSearchQuery,
    { query: query || null },
    { enabled: open },
  );

  if (!permits(shop, PUTS_PRODUCTS)) return null;
  if (!open) {
    return (
      <Button
        variant="tertiary"
        icon={<ShoppingBag aria-hidden className="size-5" />}
        onClick={() => setOpen(true)}
      >
        {t('inbox.product.pick')}
      </Button>
    );
  }
  const onSale = (found.data?.products.nodes ?? []).filter((each) => each.status === 'ACTIVE');
  const store = found.data?.shop.url.replace(/\/+$/, '') ?? '';
  return (
    <Card className="flex w-full flex-col gap-2 p-3">
      <TextField
        label={t('inbox.product.find')}
        dir="auto"
        value={words}
        onChange={(event) => setWords(event.target.value)}
      />
      {found.isPending ? (
        <p className="text-secondary">{t('state.loading')}</p>
      ) : found.isError ? (
        <p className="text-danger">{errorText(found.error, t)}</p>
      ) : onSale.length === 0 ? (
        <p className="text-secondary">{t('inbox.product.none')}</p>
      ) : (
        <ul className="flex max-h-72 flex-col gap-1 overflow-y-auto">
          {onSale.map((product) => (
            <li key={product.id}>
              <button
                type="button"
                onClick={() => {
                  onPick(
                    `${product.title}\n${priceText(product.priceRange)}\n` +
                      `${store}/products/${product.handle}`,
                  );
                  setOpen(false);
                  setWords('');
                }}
                className="flex min-h-10 w-full items-center justify-between gap-3 rounded-control px-2 py-1 text-start hover:bg-canvas"
              >
                <span className="font-medium" dir="auto">
                  {product.title}
                </span>
                <span className="num shrink-0 text-secondary">{priceText(product.priceRange)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div>
        <Button variant="tertiary" onClick={() => setOpen(false)}>
          {t('returns.cancel')}
        </Button>
      </div>
    </Card>
  );
}
