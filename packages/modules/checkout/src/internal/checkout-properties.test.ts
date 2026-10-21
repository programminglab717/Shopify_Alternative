import 'reflect-metadata';
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
    // The note still says them, the order's page not showing them yet.
    expect(placed.order.note).toBe('1 × Kurta: Name: Ali');
  });
});
