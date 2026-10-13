/** A part of a bundle as its price is shared: its variant, how many a bundle holds, its price. */
export interface BundlePart {
  variantId: string;
  /** Units in one bundle. */
  quantity: number;
  /** One unit's own price, minor units: what its share is weighed by. */
  price: bigint;
}

/** A line a bundle's part becomes: its units at one price. */
export interface SharedLine {
  variantId: string;
  quantity: number;
  unitPrice: bigint;
}

/**
 * Shares what `count` bundles cost, `count` × `price`, among their parts' lines, each part's
 * share by what it costs on its own (ADR-410), to the paisa: a line's total is its unit price
 * times its units, so what rounding leaves is a paisa more on as many units, the dearest parts'
 * first, which may make a part two lines. Parts of no price share by their units.
 */
export function shareBundlePrice(
  price: bigint,
  count: number,
  parts: readonly BundlePart[],
): SharedLine[] {
  const total = price * BigInt(count);
  const weighed = parts.some((part) => part.price > 0n);
  const weight = (part: BundlePart) => (weighed ? part.price : 1n) * BigInt(part.quantity);
  const all = parts.reduce((sum, part) => sum + weight(part), 0n);
  const shares = parts.map((part) => {
    const units = BigInt(part.quantity * count);
    // Each unit's share of the bundle's price, rounded down.
    const unitPrice = (price * weight(part)) / (all * BigInt(part.quantity));
    return { part, units, unitPrice };
  });
  let left = total - shares.reduce((sum, share) => sum + share.unitPrice * share.units, 0n);
  const extra = new Map<BundlePart, bigint>();
  // The dearest first; then as given.
  const order = [...shares].sort((a, b) =>
    a.unitPrice === b.unitPrice ? 0 : a.unitPrice > b.unitPrice ? -1 : 1,
  );
  for (const share of order) {
    if (left === 0n) break;
    const more = left < share.units ? left : share.units;
    extra.set(share.part, more);
    left -= more;
  }
  return shares.flatMap(({ part, units, unitPrice }) => {
    const more = extra.get(part) ?? 0n;
    const lines: SharedLine[] = [];
    if (more > 0n) {
      lines.push({ variantId: part.variantId, quantity: Number(more), unitPrice: unitPrice + 1n });
    }
    if (units > more) {
      lines.push({ variantId: part.variantId, quantity: Number(units - more), unitPrice });
    }
    return lines;
  });
}
