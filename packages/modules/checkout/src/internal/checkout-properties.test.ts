import 'reflect-metadata';
import { PersonalisationService, StitchingService } from '@hatti/catalog/public';
import { testDatabaseServer } from '@hatti/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseAction } from './cart-lines.js';
import type { CheckoutForm } from './checkout.service.js';
import { checkoutFixture, type CheckoutFixture } from './test-support.js';

const server = testDatabaseServer();

describe.skipIf(!server)("Orders keeping their cart lines' properties (CAT-15, ADR-687)", () => {
  let f: CheckoutFixture;
  let kurta: string;

  beforeAll(async () => {
    f = await checkoutFixture(server!);
  });

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
    [kurta] = (await f.variantsOf(f.a, 'Kurta', { price: '2,000' })) as [string];
    await f.stock(f.a, kurta, 100);
  });

  const FORM: CheckoutForm = {
    name: 'Ayesha Khan',
    phone: '0300-1234567',
    city: 'Lahore',
    address1: 'House 12, Street 4',
    address2: '',
    landmark: '',
    province: '',
    payment: '',
    code: '',
    resend: '',
  };

  it('places each line with what the shopper wrote on it, apps’ properties too', async () => {
    const action = parseAction('add', {
      items: [
        { variantId: kurta, quantity: 1, properties: { Name: 'Ali', _ref: '7' } },
        { variantId: kurta, quantity: 2 },
      ],
    });
    if ('code' in action) throw new Error(`Refused: ${JSON.stringify(action)}`);
    const added = await f.carts.act(f.a.shopId, null, action);
    if (!added.ok) throw new Error(`Refused: ${JSON.stringify(added.error)}`);
    const secret = (await f.checkouts.start(f.a.shopId, added.token!))!;
    const view = await f.checkouts.view(secret);
    if (view.kind !== 'open') throw new Error(`Expected an open checkout, got ${view.kind}`);

    const placed = await f.checkouts.place(secret, view.shown, FORM);
    if (placed.kind !== 'placed') throw new Error(`Expected it placed, got ${placed.kind}`);
    expect(
      placed.order.lines
        .map((line) => [line.quantity, line.properties])
        .sort(([a], [b]) => Number(a) - Number(b)),
    ).toEqual([
      [1, { Name: 'Ali', _ref: '7' }],
      [2, {}],
    ]);
    // Its lines say them, its note no longer (ADR-688).
    expect(placed.order.note).toBe('');
  });

  it('places a line at its price with what its answers add to each unit (ADR-697)', async () => {
    const snapshots = await f.db.tenant(f.a.shopId, (tx) =>
      f.variants.snapshotsOf(tx, f.a.shopId, [kurta]),
    );
    const fields = await new PersonalisationService(f.db).set(
      f.a,
      snapshots.get(kurta)!.productId,
      [
        { name: 'Name', kind: 'text', price: '500' },
        { name: 'Thread', kind: 'choice', choices: ['Gold', 'Silver'], price: '250.50' },
      ],
    );
    if (!fields.ok) throw new Error(`Refused: ${JSON.stringify(fields.errors)}`);
    expect(fields.value.map((field) => field.price)).toEqual([500_00, 250_50]);
    const action = parseAction('add', {
      items: [
        { variantId: kurta, quantity: 2, properties: { Name: 'Ali', Thread: 'Gold' } },
        { variantId: kurta, quantity: 1, properties: { Thread: 'Silver' } },
        { variantId: kurta, quantity: 1 },
      ],
    });
    if ('code' in action) throw new Error(`Refused: ${JSON.stringify(action)}`);
    const added = await f.carts.act(f.a.shopId, null, action);
    if (!added.ok) throw new Error(`Refused: ${JSON.stringify(added.error)}`);
    expect(added.cart.items.map((item) => [item.price, item.linePrice])).toEqual([
      [2_750_50, 5_501_00],
      [2_250_50, 2_250_50],
      [2_000_00, 2_000_00],
    ]);
    expect(added.cart.subtotal).toBe(9_751_50);

    const secret = (await f.checkouts.start(f.a.shopId, added.token!))!;
    const view = await f.checkouts.view(secret);
    if (view.kind !== 'open') throw new Error(`Expected an open checkout, got ${view.kind}`);
    const placed = await f.checkouts.place(secret, view.shown, FORM);
    if (placed.kind !== 'placed') throw new Error(`Expected it placed, got ${placed.kind}`);
    expect(
      placed.order.lines
        .map((line) => [line.quantity, line.unitPrice, line.properties])
        .sort(([, a], [, b]) => Number(b) - Number(a)),
    ).toEqual([
      [2, 2_750_50n, { Name: 'Ali', Thread: 'Gold' }],
      [1, 2_250_50n, { Thread: 'Silver' }],
      [1, 2_000_00n, {}],
    ]);
    expect(placed.order.subtotal).toBe(9_751_50n);
  });

  it('places a stitched line at its price with its stitching, keeping the day it ships by (ADR-803)', async () => {
    const snapshots = await f.db.tenant(f.a.shopId, (tx) =>
      f.variants.snapshotsOf(tx, f.a.shopId, [kurta]),
    );
    const offered = await new StitchingService(f.db).set(f.a, snapshots.get(kurta)!.productId, {
      price: '1500',
      leadDays: 7,
      measurements: ['chest'],
    });
    if (!offered.ok) throw new Error(`Refused: ${JSON.stringify(offered.errors)}`);
    const action = parseAction('add', {
      items: [
        {
          variantId: kurta,
          quantity: 1,
          properties: { Stitching: 'Stitched', 'Chest (inches)': '38' },
        },
        { variantId: kurta, quantity: 1, properties: { Stitching: 'Unstitched' } },
      ],
    });
    if ('code' in action) throw new Error(`Refused: ${JSON.stringify(action)}`);
    const added = await f.carts.act(f.a.shopId, null, action);
    if (!added.ok) throw new Error(`Refused: ${JSON.stringify(added.error)}`);
    expect(added.cart.items.map((item) => [item.price, item.stitchedDays])).toEqual([
      [3_500_00, 7],
      [2_000_00, undefined],
    ]);

    const secret = (await f.checkouts.start(f.a.shopId, added.token!))!;
    const view = await f.checkouts.view(secret);
    if (view.kind !== 'open') throw new Error(`Expected an open checkout, got ${view.kind}`);
    const placed = await f.checkouts.place(secret, view.shown, FORM);
    if (placed.kind !== 'placed') throw new Error(`Expected it placed, got ${placed.kind}`);
    const sold = new Date(placed.order.createdAt.getTime() + 5 * 3_600_000);
    sold.setUTCDate(sold.getUTCDate() + 7);
    expect(
      placed.order.lines
        .map((line) => [line.unitPrice, line.stitchedShipsOn])
        .sort(([a], [b]) => Number(b) - Number(a)),
    ).toEqual([
      [3_500_00n, sold.toISOString().slice(0, 10)],
      [2_000_00n, null],
    ]);
  });
});
