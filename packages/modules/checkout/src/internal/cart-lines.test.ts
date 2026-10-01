import { describe, expect, it } from 'vitest';
import {
  CART_LIMITS,
  EMPTY_CART,
  applyAction,
  cartJson,
  lineKey,
  parseAction,
  type Applied,
  type CartAction,
  type CartContent,
  type StoredLine,
  type VariantFacts,
} from './cart-lines.js';

const LAWN = '01900000-0000-7000-8000-000000000001';
const KURTA = '01900000-0000-7000-8000-000000000002';
const SHAWL = '01900000-0000-7000-8000-000000000003';
const DRAFT = '01900000-0000-7000-8000-000000000004';

function variant(title: string, price: number, extra: Partial<VariantFacts> = {}): VariantFacts {
  return {
    productId: `product-of-${title}`,
    title,
    variantTitle: 'Default Title',
    sku: null,
    price: BigInt(price),
    grams: 0,
    taxable: true,
    forSale: true,
    sellable: null,
    ...extra,
  };
}

const FACTS = new Map<string, VariantFacts>([
  [LAWN, variant('Lawn 3-piece', 4_500_00, { sellable: 5, grams: 400, sku: 'LAWN-3' })],
  [KURTA, variant('Kurta', 2_000_00, { variantTitle: 'M', sellable: 0 })],
  [SHAWL, variant('Shawl', 3_000_00)],
  [DRAFT, variant('Draft', 100_00, { forSale: false })],
]);

const line = (variantId: string, quantity: number, properties = {}): StoredLine => ({
  variantId,
  quantity,
  properties,
});

function act(cart: CartContent, name: 'add' | 'change' | 'update' | 'clear', body: unknown) {
  const action = parseAction(name, body);
  if ('code' in action) throw new Error(`Refused: ${JSON.stringify(action)}`);
  return applyAction(cart, action, FACTS);
}

function applied(result: Applied | { code: string }): Applied {
  if ('code' in result) throw new Error(`Refused: ${JSON.stringify(result)}`);
  return result;
}

describe('cart lines', () => {
  it('keys a line by its variant and properties, whatever their order', () => {
    const key = lineKey(line(LAWN, 1, { Name: 'Ayesha', Colour: 'Red' }));
    expect(key).toMatch(new RegExp(`^${LAWN}:[0-9a-f]{32}$`));
    expect(lineKey(line(LAWN, 3, { Colour: 'Red', Name: 'Ayesha' }))).toBe(key);
    expect(lineKey(line(LAWN, 1, { Name: 'Sana', Colour: 'Red' }))).not.toBe(key);
    expect(lineKey(line(KURTA, 1, { Name: 'Ayesha', Colour: 'Red' }))).not.toBe(key);
  });

  it('checks what a storefront sends', () => {
    expect(parseAction('add', { items: [{ variantId: LAWN, properties: { Note: ' ' } }] })).toEqual(
      {
        kind: 'add',
        // One unit unless said; a property left blank is not the line's.
        items: [line(LAWN, 1)],
      },
    );
    expect(parseAction('add', { items: [{ variantId: '123' }] })).toEqual({
      code: 'NOT_FOUND',
      variantId: '123',
    });
    const invalid = (name: 'add' | 'change' | 'update', body: unknown) =>
      (parseAction(name, body) as { message?: string }).message;
    expect(invalid('add', { items: [] })).toBe('items must list what to add');
    expect(invalid('add', { items: [{ variantId: LAWN, quantity: 0 }] })).toBe(
      'quantity must be a whole number from 1',
    );
    expect(invalid('add', { items: [{ variantId: LAWN, quantity: 1.5 }] })).toBe(
      'quantity must be a whole number from 1',
    );
    const many = Object.fromEntries(Array.from({ length: 26 }, (_, i) => [`p${i}`, 'x']));
    expect(invalid('add', { items: [{ variantId: LAWN, properties: many }] })).toBe(
      'At most 25 properties',
    );
    expect(invalid('change', { line: { index: 0 }, quantity: 1 })).toBe(
      'line must name a line by its key, its variantId, or its index from 1',
    );
    expect(invalid('update', { note: 'x'.repeat(CART_LIMITS.note + 1) })).toBe(
      'A note has at most 5000 characters',
    );
    expect(invalid('update', { attributes: { Gift: 7 } })).toBe(
      'The attribute "Gift" must be text',
    );
    expect(parseAction('clear', {})).toEqual({ kind: 'clear' });
    expect(parseAction('clear', null)).toEqual({
      code: 'INVALID',
      message: 'The body must be a JSON object',
    });
  });

  it('adds to the line with the same variant and properties, new lines first', () => {
    const cart = { ...EMPTY_CART, lines: [line(SHAWL, 1)] };
    const result = applied(
      act(cart, 'add', {
        items: [
          { variantId: LAWN, quantity: 1, properties: { Stitching: 'Yes' } },
          { variantId: SHAWL, quantity: 2 },
          { variantId: LAWN, quantity: 1 },
          { variantId: LAWN, quantity: 1, properties: { Stitching: 'Yes' } },
        ],
      }),
    );
    expect(result.lines).toEqual([
      line(LAWN, 2, { Stitching: 'Yes' }),
      line(LAWN, 1),
      line(SHAWL, 3),
    ]);
    expect(result.added).toEqual([
      lineKey(line(LAWN, 0, { Stitching: 'Yes' })),
      lineKey(line(SHAWL, 0)),
      lineKey(line(LAWN, 0)),
    ]);
  });

  it('refuses more than can be sold, or than a line or a cart can hold', () => {
    const cart = { ...EMPTY_CART, lines: [line(LAWN, 4)] };
    // Across the variant's lines: 4 in the cart and 2 more make 6 of the 5 left.
    expect(
      act(cart, 'add', { items: [{ variantId: LAWN, quantity: 2, properties: { A: 'b' } }] }),
    ).toEqual({ code: 'MAX_QUANTITY', variantId: LAWN, title: 'Lawn 3-piece', max: 5 });
    expect(applied(act(cart, 'add', { items: [{ variantId: LAWN }] })).lines).toEqual([
      line(LAWN, 5),
    ]);
    expect(act(EMPTY_CART, 'add', { items: [{ variantId: KURTA }] })).toEqual({
      code: 'MAX_QUANTITY',
      variantId: KURTA,
      title: 'Kurta',
      max: 0,
    });
    expect(act(EMPTY_CART, 'add', { items: [{ variantId: SHAWL, quantity: 10_001 }] })).toEqual({
      code: 'MAX_QUANTITY',
      variantId: SHAWL,
      title: 'Shawl',
      max: 10_000,
    });
    expect(act(EMPTY_CART, 'add', { items: [{ variantId: DRAFT }] })).toEqual({
      code: 'NOT_FOUND',
      variantId: DRAFT,
    });
    const full = {
      ...EMPTY_CART,
      lines: Array.from({ length: 100 }, (_, i) => line(SHAWL, 1, { n: String(i) })),
    };
    expect(act(full, 'add', { items: [{ variantId: SHAWL, properties: { n: 'x' } }] })).toEqual({
      code: 'MAX_LINES',
      max: 100,
    });
    // Adding to a line it has is fine.
    expect(
      applied(act(full, 'add', { items: [{ variantId: SHAWL, properties: { n: '7' } }] })).lines[7],
    ).toEqual(line(SHAWL, 2, { n: '7' }));
  });

  it('changes a line by its key, variant or place, and takes it out at 0', () => {
    const cart = {
      ...EMPTY_CART,
      lines: [line(SHAWL, 1, { Colour: 'Rust' }), line(LAWN, 2), line(SHAWL, 1)],
    };
    const byKey = { key: lineKey(line(SHAWL, 0)) };
    expect(applied(act(cart, 'change', { line: byKey, quantity: 4 })).lines[2]).toEqual(
      line(SHAWL, 4),
    );
    // A variant names its first line.
    expect(applied(act(cart, 'change', { line: { variantId: SHAWL }, quantity: 0 })).lines).toEqual(
      [line(LAWN, 2), line(SHAWL, 1)],
    );
    expect(applied(act(cart, 'change', { line: { index: 2 }, quantity: 5 })).lines[1]).toEqual(
      line(LAWN, 5),
    );
    expect(act(cart, 'change', { line: { index: 4 }, quantity: 1 })).toEqual({
      code: 'LINE_NOT_FOUND',
    });
    expect(act(cart, 'change', { line: { variantId: KURTA }, quantity: 1 })).toEqual({
      code: 'LINE_NOT_FOUND',
    });
    // New properties the same as another line's make the two one.
    expect(
      applied(act(cart, 'change', { line: { index: 1 }, properties: { Colour: '' } })).lines,
    ).toEqual([line(LAWN, 2), line(SHAWL, 2)]);
  });

  it('lets a line whose stock ran out go down, but not up', () => {
    // Added when there were 5; there are fewer now.
    const cart = { ...EMPTY_CART, lines: [line(KURTA, 3)] };
    expect(applied(act(cart, 'change', { line: { index: 1 }, quantity: 2 })).lines).toEqual([
      line(KURTA, 2),
    ]);
    expect(act(cart, 'change', { line: { index: 1 }, quantity: 4 })).toMatchObject({
      code: 'MAX_QUANTITY',
      max: 0,
    });
    // Another line's shortage does not stop other changes.
    expect(applied(act(cart, 'add', { items: [{ variantId: SHAWL }] })).lines).toEqual([
      line(SHAWL, 1),
      line(KURTA, 3),
    ]);
  });

  it('updates lines as the cart was, adding variants it lacks, with the note and attributes', () => {
    const cart: CartContent = {
      lines: [line(LAWN, 1), line(SHAWL, 1)],
      note: '',
      attributes: { Gift: 'Yes', Wrap: 'Red' },
    };
    const result = applied(
      act(cart, 'update', {
        updates: [
          { line: { index: 1 }, quantity: 0 },
          // Still the second line, though the first is going.
          { line: { index: 2 }, quantity: 3 },
          // A variant the cart lacks, at 0, adds nothing.
          { line: { variantId: KURTA }, quantity: 0 },
        ],
        note: 'Please call before coming',
        attributes: { Wrap: '', Delivery: 'Evening' },
      }),
    );
    expect(result).toEqual({
      lines: [line(SHAWL, 3)],
      note: 'Please call before coming',
      attributes: { Gift: 'Yes', Delivery: 'Evening' },
      added: [],
    });
    expect(
      applied(act(cart, 'update', { updates: [{ line: { variantId: SHAWL }, quantity: 2 }] }))
        .lines,
    ).toEqual([line(LAWN, 1), line(SHAWL, 2)]);
    expect(
      applied(act(cart, 'update', { updates: [{ line: { variantId: LAWN }, quantity: 5 }] })).lines,
    ).toEqual([line(LAWN, 5), line(SHAWL, 1)]);
    // A variant the cart lacks is added, first.
    expect(
      applied(
        act(cart, 'update', {
          updates: [
            { line: { variantId: LAWN }, quantity: 2 },
            { line: { variantId: KURTA }, quantity: 0 },
          ],
        }),
      ).lines,
    ).toEqual([line(LAWN, 2), line(SHAWL, 1)]);
    const unknown = '01900000-0000-7000-8000-000000000009';
    expect(
      act(cart, 'update', { updates: [{ line: { variantId: unknown }, quantity: 1 }] }),
    ).toEqual({ code: 'NOT_FOUND', variantId: unknown });
    expect(act(cart, 'update', { updates: [{ line: { index: 3 }, quantity: 1 }] })).toEqual({
      code: 'LINE_NOT_FOUND',
    });
  });

  it('clears the lines, keeping the note and attributes', () => {
    const cart: CartContent = { lines: [line(LAWN, 1)], note: 'Eid', attributes: { Gift: 'Yes' } };
    expect(applied(act(cart, 'clear', {}))).toEqual({
      lines: [],
      note: 'Eid',
      attributes: { Gift: 'Yes' },
      added: [],
    });
  });

  it('drops lines no longer for sale at the next change', () => {
    const gone = '01900000-0000-7000-8000-000000000009';
    const cart = { ...EMPTY_CART, lines: [line(DRAFT, 1), line(gone, 1), line(SHAWL, 1)] };
    expect(applied(act(cart, 'change', { line: { index: 1 }, quantity: 2 })).lines).toEqual([
      line(SHAWL, 2),
    ]);
  });

  it('prices a cart as the catalog prices its variants now', () => {
    const cart: CartContent = {
      lines: [line(LAWN, 2, { Stitching: 'Yes' }), line(LAWN, 4), line(KURTA, 1), line(DRAFT, 1)],
      note: 'Eid',
      attributes: {},
    };
    const json = cartJson(cart, FACTS);
    expect(
      json.items.map((item) => [item.title, item.quantity, item.linePrice, item.maxQuantity]),
    ).toEqual([
      // 6 of the 5 left: the first line can have 1 beside the other's 4, the second 3.
      ['Lawn 3-piece', 2, 900_000, 1],
      ['Lawn 3-piece', 4, 1_800_000, 3],
      ['Kurta', 1, 200_000, 0],
    ]);
    expect(json.items[0]).toEqual({
      key: lineKey(line(LAWN, 0, { Stitching: 'Yes' })),
      variantId: LAWN,
      productId: 'product-of-Lawn 3-piece',
      quantity: 2,
      properties: { Stitching: 'Yes' },
      price: 450_000,
      linePrice: 900_000,
      title: 'Lawn 3-piece',
      variantTitle: 'Default Title',
      sku: 'LAWN-3',
      grams: 400,
      taxable: true,
      maxQuantity: 1,
    });
    expect([json.itemCount, json.subtotal, json.totalWeightGrams, json.note]).toEqual([
      7,
      2_900_000,
      2_400,
      'Eid',
    ]);
    const action: CartAction = { kind: 'clear' };
    expect(cartJson(applied(applyAction(cart, action, FACTS)), FACTS).items).toEqual([]);
  });
});
