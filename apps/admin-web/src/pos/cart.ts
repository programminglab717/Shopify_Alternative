import type { PosCatalogItemValue } from '../api/types';

// The till's sums and lookups (POS-01, ADR-872), done on the device so that it sells offline too:
// amounts in paisa, whole numbers, as the core keeps them; the core checks them again.

/** An amount as the API gives it, "3000.00", in paisa: 300000. */
export function paisaOf(amount: string): number {
  const value = Number(amount.replace(/,/g, '').trim());
  return Number.isFinite(value) ? Math.round(value * 100) : 0;
}

/** Paisa as the API takes an amount: 300000 as "3000.00". */
export function amountOf(paisa: number): string {
  const sign = paisa < 0 ? '-' : '';
  const whole = Math.abs(paisa);
  return `${sign}${Math.floor(whole / 100)}.${String(whole % 100).padStart(2, '0')}`;
}

export interface CartLine {
  variantId: string;
  title: string;
  variantTitle: string;
  sku: string | null;
  quantity: number;
  /** Each, in paisa. */
  unitPrice: number;
}

/** The cart with one more of `item`: its line's quantity up, or a new line last. */
export function added(lines: readonly CartLine[], item: PosCatalogItemValue): CartLine[] {
  const found = lines.find((line) => line.variantId === item.variantId);
  if (found) {
    return lines.map((line) => (line === found ? { ...line, quantity: line.quantity + 1 } : line));
  }
  return [
    ...lines,
    {
      variantId: item.variantId,
      title: item.productTitle,
      variantTitle: item.variantTitle,
      sku: item.sku,
      quantity: 1,
      unitPrice: paisaOf(item.price.amount),
    },
  ];
}

/** What the cart comes to, in paisa: its items, the discount off them, and the total. */
export function totalsOf(
  lines: readonly CartLine[],
  discount: number,
): { subtotal: number; discount: number; total: number } {
  const subtotal = lines.reduce((sum, line) => sum + line.unitPrice * line.quantity, 0);
  const off = Math.min(Math.max(discount, 0), subtotal);
  return { subtotal, discount: off, total: subtotal - off };
}

/** The item a scanner's or staff's code names exactly: its barcode, or its SKU. */
export function byCode(
  catalog: readonly PosCatalogItemValue[],
  code: string,
): PosCatalogItemValue | null {
  const wanted = code.trim().toLowerCase();
  if (!wanted) return null;
  return (
    catalog.find((item) => item.barcode?.toLowerCase() === wanted) ??
    catalog.find((item) => item.sku?.toLowerCase() === wanted) ??
    null
  );
}

/** Items whose title, variant, SKU or barcode hold every word of `query`, at most `limit`. */
export function matching(
  catalog: readonly PosCatalogItemValue[],
  query: string,
  limit = 30,
): PosCatalogItemValue[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return catalog.slice(0, limit);
  return catalog
    .filter((item) => {
      const text = [item.productTitle, item.variantTitle, item.sku ?? '', item.barcode ?? '']
        .join(' ')
        .toLowerCase();
      return words.every((word) => text.includes(word));
    })
    .slice(0, limit);
}

/** Notes a cashier may hand over for a cash total: the total, and the round sums above it. */
export function quickCash(total: number): number[] {
  const notes = [100, 500, 1000, 5000].map((rupees) => rupees * 100);
  const sums = new Set<number>([total]);
  for (const note of notes) {
    const rounded = Math.ceil(total / note) * note;
    if (rounded > total) sums.add(rounded);
  }
  return [...sums].sort((a, b) => a - b).slice(0, 4);
}
