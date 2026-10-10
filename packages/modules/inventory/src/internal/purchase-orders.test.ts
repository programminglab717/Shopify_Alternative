import 'reflect-metadata';
import { testDatabaseServer } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { purchaseOrderUri } from './purchase-order.service.js';
import type { LocationRecord } from './records.js';
import { errorsOf, inventoryFixture, unwrap, type InventoryFixture } from './test-support.js';

const server = testDatabaseServer();

describe.skipIf(!server)('PurchaseOrderService (INV-05)', () => {
  let f: InventoryFixture;
  let warehouse: LocationRecord;
  let variants: string[];

  const supplier = async (name = 'Faisalabad Textiles') =>
    unwrap(await f.purchaseOrders.createSupplier(f.a, { name, phone: '0300 1234567' }));
  const levelAt = async (variantId: string) =>
    (await f.inventory.item(f.a, variantId))!.levels.find(
      (level) => level.location.id === warehouse.id,
    );

  beforeAll(async () => {
    f = await inventoryFixture(server!);
  });

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
    warehouse = await f.location(f.a, 'Warehouse');
    variants = await f.variantsOf(f.a, 'Lawn suit', ['S', 'M']);
  });

  it('keeps suppliers by name, one of each name, with a mobile number', async () => {
    const made = await supplier();
    expect(made).toMatchObject({ name: 'Faisalabad Textiles', phone: '+923001234567', note: null });
    expect(
      errorsOf(await f.purchaseOrders.createSupplier(f.a, { name: 'faisalabad textiles' })),
    ).toEqual([['input.name', 'TAKEN']]);
    expect(
      errorsOf(await f.purchaseOrders.createSupplier(f.a, { name: ' ', phone: '042 111 222' })),
    ).toEqual([
      ['input.name', 'BLANK'],
      ['input.phone', 'INVALID'],
    ]);
    const changed = unwrap(
      await f.purchaseOrders.updateSupplier(f.a, made.id, {
        phone: null,
        note: 'Pays on delivery',
      }),
    );
    expect(changed).toMatchObject({
      name: 'Faisalabad Textiles',
      phone: null,
      note: 'Pays on delivery',
    });
    await supplier('Ajrak House');
    expect((await f.purchaseOrders.suppliers(f.a)).map((each) => each.name)).toEqual([
      'Ajrak House',
      'Faisalabad Textiles',
    ]);
    expect(await f.purchaseOrders.suppliers(f.b)).toEqual([]);
    expect(errorsOf(await f.purchaseOrders.updateSupplier(f.b, made.id, { note: 'x' }))).toEqual([
      ['id', 'NOT_FOUND'],
    ]);
  });

  it('orders goods for a location, numbered for the shop, each line named as the variant was', async () => {
    const from = await supplier();
    const order = unwrap(
      await f.purchaseOrders.create(f.a, {
        supplierId: from.id,
        locationId: warehouse.id,
        reference: 'Bill 4471',
        expectedOn: '2026-11-30',
        lines: [
          { inventoryItemId: variants[0]!, quantity: 10, unitCost: '1450' },
          { inventoryItemId: variants[1]!, quantity: 6 },
        ],
      }),
    );
    expect(order).toMatchObject({
      number: 1,
      status: 'open',
      supplier: { name: 'Faisalabad Textiles' },
      location: { name: 'Warehouse' },
      reference: 'Bill 4471',
      expectedOn: '2026-11-30',
      closedAt: null,
      lines: [
        {
          variantId: variants[0],
          productTitle: 'Lawn suit',
          variantTitle: 'S',
          quantity: 10,
          received: 0,
          unitCost: 145000n,
        },
        { variantId: variants[1], variantTitle: 'M', quantity: 6, received: 0, unitCost: null },
      ],
    });
    const second = unwrap(
      await f.purchaseOrders.create(f.a, {
        supplierId: from.id,
        locationId: warehouse.id,
        lines: [{ inventoryItemId: variants[0]!, quantity: 1 }],
      }),
    );
    expect(second.number).toBe(2);
    // Ordering is not stock: nothing is on hand until it comes.
    expect(await levelAt(variants[0]!)).toBeUndefined();

    const page = await f.purchaseOrders.list(f.a, { first: 1 });
    expect(page.items.map((each) => each.number)).toEqual([2]);
    expect(page.hasNextPage).toBe(true);
    const next = await f.purchaseOrders.list(f.a, { first: 1, afterNumber: 2 });
    expect(next.items.map((each) => each.number)).toEqual([1]);
    expect(await f.purchaseOrders.get(f.b, order.id)).toBeNull();
    expect((await f.purchaseOrders.list(f.b, { first: 10 })).items).toEqual([]);
  });

  it('checks an order before keeping it', async () => {
    const from = await supplier();
    const closed = await f.location(f.a, 'Closed');
    unwrap(await f.locations.deactivate(f.a, closed.id));
    expect(
      errorsOf(
        await f.purchaseOrders.create(f.a, {
          supplierId: from.id,
          locationId: warehouse.id,
          expectedOn: '2026-02-30',
          lines: [
            { inventoryItemId: variants[0]!, quantity: 0, unitCost: 'free' },
            { inventoryItemId: variants[0]!, quantity: 1 },
          ],
        }),
      ),
    ).toEqual([
      ['input.expectedOn', 'INVALID'],
      ['input.lines.0.quantity', 'INVALID'],
      ['input.lines.0.unitCost', 'INVALID'],
      ['input.lines.1', 'INVALID'],
    ]);
    expect(
      errorsOf(
        await f.purchaseOrders.create(f.a, {
          supplierId: from.id,
          locationId: warehouse.id,
          lines: [],
        }),
      ),
    ).toEqual([['input.lines', 'BLANK']]);
    const [theirs] = await f.variantsOf(f.b, 'Not mine');
    expect(
      errorsOf(
        await f.purchaseOrders.create(f.a, {
          supplierId: newId(),
          locationId: closed.id,
          lines: [{ inventoryItemId: theirs!, quantity: 1 }],
        }),
      ),
    ).toEqual([
      ['input.supplierId', 'NOT_FOUND'],
      ['input.locationId', 'INVALID'],
      ['input.lines.0.inventoryItemId', 'NOT_FOUND'],
    ]);
  });

  it('receives goods into stock as they come, in one adjustment naming the order, until all have come', async () => {
    const order = unwrap(
      await f.purchaseOrders.create(f.a, {
        supplierId: (await supplier()).id,
        locationId: warehouse.id,
        lines: [
          { inventoryItemId: variants[0]!, quantity: 10 },
          { inventoryItemId: variants[1]!, quantity: 6 },
        ],
      }),
    );
    const [small, medium] = order.lines as [(typeof order.lines)[0], (typeof order.lines)[0]];
    const part = unwrap(
      await f.purchaseOrders.receive(f.a, order.id, {
        lines: [
          { lineId: small.id, quantity: 4 },
          { lineId: medium.id, quantity: 6 },
        ],
      }),
    );
    expect(part.status).toBe('open');
    expect(part.lines.map((line) => line.received)).toEqual([4, 6]);
    expect(await levelAt(variants[0]!)).toMatchObject({ onHand: 4, available: 4 });
    expect((await f.inventory.item(f.a, variants[0]!))!.tracked).toBe(true);
    const history = await f.inventory.history(f.a, variants[0]!, { first: 5 });
    expect(history.items).toMatchObject([
      {
        name: 'on_hand',
        delta: 4,
        reason: 'received',
        referenceDocumentUri: purchaseOrderUri(order.id),
      },
    ]);

    // Never more than is still to come; all or nothing.
    const tooMany = await f.purchaseOrders.receive(f.a, order.id, {
      lines: [
        { lineId: small.id, quantity: 7 },
        { lineId: newId(), quantity: 1 },
      ],
    });
    expect(errorsOf(tooMany)).toEqual([
      ['input.lines.0.quantity', 'INVALID'],
      ['input.lines.1.lineId', 'NOT_FOUND'],
    ]);
    expect(!tooMany.ok && tooMany.errors[0]!.message).toBe(
      "Only 6 still to come of 10; can't receive 7",
    );
    expect((await levelAt(variants[0]!))?.onHand).toBe(4);

    const done = unwrap(
      await f.purchaseOrders.receive(f.a, order.id, { lines: [{ lineId: small.id, quantity: 6 }] }),
    );
    expect(done.status).toBe('received');
    expect(done.closedAt).toBeInstanceOf(Date);
    expect((await levelAt(variants[0]!))?.onHand).toBe(10);
    expect(
      errorsOf(
        await f.purchaseOrders.receive(f.a, order.id, {
          lines: [{ lineId: small.id, quantity: 1 }],
        }),
      ),
    ).toEqual([['id', 'INVALID']]);
    expect(
      errorsOf(
        await f.purchaseOrders.receive(f.b, order.id, {
          lines: [{ lineId: small.id, quantity: 1 }],
        }),
      ),
    ).toEqual([['id', 'NOT_FOUND']]);
  });

  it('closes an order with what came, the rest no longer expected', async () => {
    const order = unwrap(
      await f.purchaseOrders.create(f.a, {
        supplierId: (await supplier()).id,
        locationId: warehouse.id,
        lines: [{ inventoryItemId: variants[0]!, quantity: 10 }],
      }),
    );
    unwrap(
      await f.purchaseOrders.receive(f.a, order.id, {
        lines: [{ lineId: order.lines[0]!.id, quantity: 3 }],
      }),
    );
    const closed = unwrap(await f.purchaseOrders.close(f.a, order.id));
    expect(closed).toMatchObject({ status: 'closed', lines: [{ quantity: 10, received: 3 }] });
    expect(errorsOf(await f.purchaseOrders.close(f.a, order.id))).toEqual([['id', 'INVALID']]);
    expect(errorsOf(await f.purchaseOrders.close(f.b, order.id))).toEqual([['id', 'NOT_FOUND']]);
    expect((await f.purchaseOrders.list(f.a, { first: 5, status: 'open' })).items).toEqual([]);
    expect((await f.purchaseOrders.list(f.a, { first: 5, status: 'closed' })).items).toHaveLength(
      1,
    );
  });

  it('changes an open order, never below what came, and is received once all of it has', async () => {
    const [large] = await f.variantsOf(f.a, 'Lawn suit L');
    const order = unwrap(
      await f.purchaseOrders.create(f.a, {
        supplierId: (await supplier()).id,
        locationId: warehouse.id,
        lines: [
          { inventoryItemId: variants[0]!, quantity: 10, unitCost: '1450' },
          { inventoryItemId: variants[1]!, quantity: 6 },
        ],
      }),
    );
    const [small, medium] = order.lines as [(typeof order.lines)[0], (typeof order.lines)[0]];
    unwrap(
      await f.purchaseOrders.receive(f.a, order.id, { lines: [{ lineId: small.id, quantity: 4 }] }),
    );

    expect(
      errorsOf(
        await f.purchaseOrders.update(f.a, order.id, {
          expectedOn: 'soon',
          linesToAdd: [{ inventoryItemId: variants[1]!, quantity: 1 }],
          linesToUpdate: [{ lineId: small.id, quantity: 3 }],
          lineIdsToRemove: [small.id],
        }),
      ),
    ).toEqual([['input.expectedOn', 'INVALID']]);
    const refused = await f.purchaseOrders.update(f.a, order.id, {
      linesToAdd: [{ inventoryItemId: variants[1]!, quantity: 1 }],
      linesToUpdate: [{ lineId: small.id, quantity: 3 }],
      lineIdsToRemove: [small.id, newId()],
    });
    expect(errorsOf(refused)).toEqual([
      ['input.lineIdsToRemove.0', 'INVALID'],
      ['input.lineIdsToRemove.1', 'NOT_FOUND'],
      ['input.linesToUpdate.0.lineId', 'INVALID'],
      ['input.linesToAdd.0.inventoryItemId', 'INVALID'],
    ]);
    expect(!refused.ok && refused.errors[0]!.message).toBe(
      "4 came already; the line can't be removed",
    );
    expect(
      errorsOf(
        await f.purchaseOrders.update(f.a, order.id, {
          linesToUpdate: [{ lineId: small.id, quantity: 3 }],
        }),
      ),
    ).toEqual([['input.linesToUpdate.0.quantity', 'INVALID']]);

    const changed = unwrap(
      await f.purchaseOrders.update(f.a, order.id, {
        reference: 'Bill 4471',
        expectedOn: '2026-12-01',
        linesToAdd: [{ inventoryItemId: large!, quantity: 2, unitCost: '1600' }],
        linesToUpdate: [{ lineId: small.id, quantity: 8, unitCost: '' }],
        lineIdsToRemove: [medium.id],
      }),
    );
    expect(changed).toMatchObject({
      status: 'open',
      reference: 'Bill 4471',
      expectedOn: '2026-12-01',
      lines: [
        { variantTitle: 'S', quantity: 8, received: 4, unitCost: null },
        { productTitle: 'Lawn suit L', quantity: 2, received: 0, unitCost: 160000n },
      ],
    });
    // Nothing left to come once the large is taken off and the small cut to what came.
    const done = unwrap(
      await f.purchaseOrders.update(f.a, order.id, {
        linesToUpdate: [{ lineId: small.id, quantity: 4 }],
        lineIdsToRemove: [changed.lines[1]!.id],
      }),
    );
    expect(done).toMatchObject({ status: 'received', lines: [{ quantity: 4, received: 4 }] });
    expect(done.closedAt).toBeInstanceOf(Date);
    expect(errorsOf(await f.purchaseOrders.update(f.a, order.id, { note: 'x' }))).toEqual([
      ['id', 'INVALID'],
    ]);
    expect(errorsOf(await f.purchaseOrders.update(f.b, order.id, { note: 'x' }))).toEqual([
      ['id', 'NOT_FOUND'],
    ]);
  });

  it("averages a line's cost into its variant's as the goods come, with what was on hand", async () => {
    const costs = () =>
      f.db.tenant(f.a.shopId, async (tx) => {
        const found = await f.variants.snapshotsOf(tx, f.a.shopId, variants);
        return variants.map((id) => found.get(id)?.cost ?? null);
      });
    // 10 small on hand at Rs 1,000 each; no medium, nor its cost.
    await f.db.tenant(f.a.shopId, (tx) =>
      f.variants.setCostsIn(tx, f.a.shopId, new Map([[variants[0]!, 100000n]])),
    );
    unwrap(
      await f.inventory.setQuantities(f.a, {
        name: 'on_hand',
        reason: 'cycle_count_available',
        quantities: [{ inventoryItemId: variants[0]!, locationId: warehouse.id, quantity: 10 }],
      }),
    );
    const order = unwrap(
      await f.purchaseOrders.create(f.a, {
        supplierId: (await supplier()).id,
        locationId: warehouse.id,
        lines: [
          { inventoryItemId: variants[0]!, quantity: 30, unitCost: '1300' },
          { inventoryItemId: variants[1]!, quantity: 5, unitCost: '900.50' },
        ],
      }),
    );
    const [small, medium] = order.lines as [(typeof order.lines)[0], (typeof order.lines)[0]];
    unwrap(
      await f.purchaseOrders.receive(f.a, order.id, {
        lines: [
          { lineId: small.id, quantity: 10 },
          { lineId: medium.id, quantity: 5 },
        ],
      }),
    );
    // (10 × 1,000 + 10 × 1,300) / 20 = 1,150; the medium at what the order says.
    expect(await costs()).toEqual([115000n, 90050n]);
    unwrap(
      await f.purchaseOrders.receive(f.a, order.id, { lines: [{ lineId: small.id, quantity: 7 }] }),
    );
    // (20 × 1,150 + 7 × 1,300) / 27 = 1,188.888…, to the paisa.
    expect(await costs()).toEqual([118889n, 90050n]);
  });

  it('prints an order for its supplier, in English and Urdu, with what it costs where said', async () => {
    const order = unwrap(
      await f.purchaseOrders.create(f.a, {
        supplierId: (await supplier()).id,
        locationId: warehouse.id,
        reference: 'Bill 4471',
        expectedOn: '2026-11-30',
        note: 'Pack sizes apart',
        lines: [
          { inventoryItemId: variants[0]!, quantity: 10, unitCost: '1450' },
          { inventoryItemId: variants[1]!, quantity: 6 },
        ],
      }),
    );
    const both = (await f.purchaseOrders.document(f.a, order.id, 'bilingual'))!;
    expect(both).toMatchObject({
      title: 'Purchase order PO-1',
      fileName: 'purchase-order-1.html',
    });
    for (const shown of [
      'Purchase order',
      'خریداری آرڈر',
      'PO-1',
      'Faisalabad Textiles',
      '0300 1234567',
      'Bill 4471',
      'Warehouse',
      '30 Nov 2026',
      'Lawn suit',
      'Rs 14,500',
      'Pack sizes apart',
    ]) {
      expect(both.html).toContain(shown);
    }
    const urdu = (await f.purchaseOrders.document(f.a, order.id, 'urdu'))!;
    expect(urdu.html).toContain('خریداری آرڈر');
    expect(urdu.html).not.toContain('>Purchase order<');
    expect(await f.purchaseOrders.document(f.b, order.id, 'english')).toBeNull();
  });

  it("tells what of a variant is on order, and its latest order's supplier and cost", async () => {
    const [small, medium] = variants;
    expect(await f.purchaseOrders.reordersOf(f.a, [small!, medium!])).toEqual(new Map());
    const first = unwrap(
      await f.purchaseOrders.create(f.a, {
        supplierId: (await supplier()).id,
        locationId: warehouse.id,
        lines: [
          { inventoryItemId: small!, quantity: 10, unitCost: '1450' },
          { inventoryItemId: medium!, quantity: 4 },
        ],
      }),
    );
    unwrap(
      await f.purchaseOrders.receive(f.a, first.id, {
        lines: [{ lineId: first.lines[0]!.id, quantity: 3 }],
      }),
    );
    const ajrak = await supplier('Ajrak House');
    const second = unwrap(
      await f.purchaseOrders.create(f.a, {
        supplierId: ajrak.id,
        locationId: warehouse.id,
        lines: [{ inventoryItemId: small!, quantity: 5, unitCost: '1300.50' }],
      }),
    );
    let reorders = await f.purchaseOrders.reordersOf(f.a, [small!, medium!]);
    expect(reorders.get(small!)).toMatchObject({
      incoming: 7 + 5,
      lastSupplier: { name: 'Ajrak House' },
      lastUnitCost: 130050n,
    });
    expect(reorders.get(medium!)).toMatchObject({
      incoming: 4,
      lastSupplier: { name: 'Faisalabad Textiles' },
      lastUnitCost: null,
    });
    unwrap(await f.purchaseOrders.close(f.a, first.id));
    unwrap(await f.purchaseOrders.close(f.a, second.id));
    reorders = await f.purchaseOrders.reordersOf(f.a, [small!, medium!]);
    expect(reorders.get(small!)).toMatchObject({ incoming: 0, lastSupplier: { id: ajrak.id } });
    expect(reorders.get(medium!)).toMatchObject({ incoming: 0 });
    expect(await f.purchaseOrders.reordersOf(f.b, [small!])).toEqual(new Map());
  });
});
