import { describe, expect, it } from 'vitest';
import { shownItems } from './shown-order.js';

describe("A customer's page's rows (ADR-411)", () => {
  it("shows a bundle once, where its first part is, with its parts' lines its own", () => {
    const suit = { key: 'k1', title: 'Eid 3-piece suit', quantity: 2 };
    const line = (title: string, quantity: number, total: bigint, bundle = suit) => ({
      title,
      variantTitle: 'Default Title',
      quantity,
      total,
      bundle,
    });
    const socks = { ...line('Socks', 1, 40_000n), bundle: null };
    expect(
      shownItems([
        socks,
        line('Lawn shirt', 2, 600_000n),
        { ...line('Cotton trouser', 1, 75_001n), variantTitle: 'M' },
        { ...line('Cotton trouser', 3, 224_999n), variantTitle: 'M' },
      ]),
    ).toEqual([
      { line: socks },
      {
        bundle: {
          title: 'Eid 3-piece suit',
          quantity: 2,
          total: 900_000n,
          parts: [
            { name: 'Lawn shirt', quantity: 2 },
            { name: 'Cotton trouser (M)', quantity: 4 },
          ],
        },
      },
    ]);
  });
});
