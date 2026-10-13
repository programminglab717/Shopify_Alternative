import { describe, expect, it } from 'vitest';
import { shareBundlePrice, type BundlePart } from './bundle-lines.js';

const total = (lines: ReturnType<typeof shareBundlePrice>) =>
  lines.reduce((sum, line) => sum + line.unitPrice * BigInt(line.quantity), 0n);

describe("A bundle's price shared among its parts (ADR-410)", () => {
  const SUIT: BundlePart[] = [
    { variantId: 'shirt', quantity: 1, price: 400_000n },
    { variantId: 'dupatta', quantity: 1, price: 200_000n },
    { variantId: 'trouser', quantity: 1, price: 200_000n },
  ];

  it('shares by what each part costs alone, to the paisa', () => {
    // Rs 8,000 of parts for Rs 6,000.
    expect(shareBundlePrice(600_000n, 1, SUIT)).toEqual([
      { variantId: 'shirt', quantity: 1, unitPrice: 300_000n },
      { variantId: 'dupatta', quantity: 1, unitPrice: 150_000n },
      { variantId: 'trouser', quantity: 1, unitPrice: 150_000n },
    ]);
    const odd = shareBundlePrice(599_999n, 2, SUIT);
    expect(total(odd)).toBe(1_199_998n);
    expect(odd.every((line) => line.unitPrice > 0n)).toBe(true);
  });

  it('makes a multipack two lines where its price does not divide, the total exact', () => {
    // Three for Rs 1,000: two at Rs 333.33 and one at Rs 333.34.
    const pack = shareBundlePrice(100_000n, 1, [
      { variantId: 'socks', quantity: 3, price: 40_000n },
    ]);
    expect(pack).toEqual([
      { variantId: 'socks', quantity: 1, unitPrice: 33_334n },
      { variantId: 'socks', quantity: 2, unitPrice: 33_333n },
    ]);
    expect(
      total(shareBundlePrice(100_000n, 7, [{ variantId: 'socks', quantity: 3, price: 0n }])),
    ).toBe(700_000n);
  });

  it('shares by units when no part has a price, and gives a free bundle for nothing', () => {
    expect(
      shareBundlePrice(300n, 1, [
        { variantId: 'a', quantity: 1, price: 0n },
        { variantId: 'b', quantity: 2, price: 0n },
      ]),
    ).toEqual([
      { variantId: 'a', quantity: 1, unitPrice: 100n },
      { variantId: 'b', quantity: 2, unitPrice: 100n },
    ]);
    expect(total(shareBundlePrice(0n, 3, SUIT))).toBe(0n);
  });
});
