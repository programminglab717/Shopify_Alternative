import 'reflect-metadata';
import { testDatabaseServer } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { LocationRecord } from './records.js';
import { transferUri } from './transfer.service.js';
import { errorsOf, inventoryFixture, unwrap, type InventoryFixture } from './test-support.js';

const server = testDatabaseServer();

describe.skipIf(!server)('TransferService (INV-04)', () => {
  let f: InventoryFixture;
  let warehouse: LocationRecord;
  let store: LocationRecord;
  let variants: string[];

  const levelAt = async (variantId: string, location: LocationRecord) =>
    (await f.inventory.item(f.a, variantId))!.levels.find(
      (level) => level.location.id === location.id,
    );
  const stock = (variantId: string, quantity: number, location = warehouse) =>
    f.inventory.setQuantities(f.a, {
      name: 'available',
      reason: 'cycle_count_available',
      quantities: [{ inventoryItemId: variantId, locationId: location.id, quantity }],
    });
  const send = (lines: [string, number][], from = warehouse, to = store) =>
    f.transfers.create(f.a, {
      originId: from.id,
      destinationId: to.id,
      reference: 'TCS 7731',
      lines: lines.map(([inventoryItemId, quantity]) => ({ inventoryItemId, quantity })),
    });

  beforeAll(async () => {
    f = await inventoryFixture(server!);
  });

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
    warehouse = await f.location(f.a, 'Warehouse');
    store = await f.location(f.a, 'Karachi store', { fulfillsOnlineOrders: false });
    variants = await f.variantsOf(f.a, 'Lawn suit', ['S', 'M']);
    unwrap(await stock(variants[0]!, 10));
    unwrap(await stock(variants[1]!, 3));
  });

  it('sends stock, off on hand where it leaves, on its way until it is received in parts', async () => {
    const [small, medium] = variants as [string, string];
    const sent = unwrap(
      await send([
        [small, 6],
        [medium, 3],
      ]),
    );
    expect(sent).toMatchObject({
      number: 1,
      status: 'in_transit',
      origin: { id: warehouse.id },
      destination: { id: store.id },
      reference: 'TCS 7731',
      closedAt: null,
    });
    expect(sent.lines.map((line) => [line.variantTitle, line.quantity, line.received])).toEqual([
      ['S', 6, 0],
      ['M', 3, 0],
    ]);
    expect(await levelAt(small, warehouse)).toMatchObject({ onHand: 4, available: 4 });
    expect(await levelAt(small, store)).toBeUndefined();
    expect((await f.inventory.history(f.a, small, { first: 1 })).items).toMatchObject([
      {
        name: 'on_hand',
        delta: -6,
        reason: 'movement_created',
        referenceDocumentUri: transferUri(sent.id),
      },
    ]);
    // On its way to the store, for what runs low there.
    expect(await f.transfers.incomingOf(f.a, [small, medium], store.id)).toEqual(
      new Map([
        [small, 6],
        [medium, 3],
      ]),
    );
    expect((await f.transfers.incomingOf(f.a, [small], warehouse.id)).get(small)).toBe(0);

    const [first, second] = sent.lines as [(typeof sent.lines)[0], (typeof sent.lines)[0]];
    const part = unwrap(
      await f.transfers.receive(f.a, sent.id, { lines: [{ lineId: first.id, quantity: 4 }] }),
    );
    expect(part.status).toBe('in_transit');
    expect(await levelAt(small, store)).toMatchObject({ onHand: 4, available: 4 });
    expect((await f.inventory.history(f.a, small, { first: 1 })).items[0]).toMatchObject({
      delta: 4,
      reason: 'movement_received',
      location: { id: store.id },
    });
    // Never more than is still on the way; all or nothing.
    expect(
      errorsOf(
        await f.transfers.receive(f.a, sent.id, {
          lines: [
            { lineId: first.id, quantity: 3 },
            { lineId: newId(), quantity: 1 },
          ],
        }),
      ),
    ).toEqual([
      ['input.lines.0.quantity', 'INVALID'],
      ['input.lines.1.lineId', 'NOT_FOUND'],
    ]);
    const done = unwrap(
      await f.transfers.receive(f.a, sent.id, {
        lines: [
          { lineId: first.id, quantity: 2 },
          { lineId: second.id, quantity: 3 },
        ],
      }),
    );
    expect(done.status).toBe('received');
    expect(done.closedAt).toBeInstanceOf(Date);
    expect(await levelAt(medium, store)).toMatchObject({ onHand: 3 });
    expect(await levelAt(medium, warehouse)).toMatchObject({ onHand: 0 });
    expect(errorsOf(await f.transfers.cancel(f.a, sent.id))).toEqual([['id', 'INVALID']]);

    // Listed the newest first, by status or by either end.
    const other = unwrap(await send([[small, 1]], store, warehouse));
    expect(other.number).toBe(2);
    const listed = async (options: Parameters<typeof f.transfers.list>[1]) =>
      (await f.transfers.list(f.a, options)).items.map((transfer) => transfer.number);
    expect(await listed({ first: 10 })).toEqual([2, 1]);
    expect(await listed({ first: 10, status: 'in_transit' })).toEqual([2]);
    expect(await listed({ first: 10, locationId: store.id })).toEqual([2, 1]);
    expect(await listed({ first: 1, afterNumber: 2 })).toEqual([1]);
    expect((await f.transfers.list(f.b, { first: 10 })).items).toEqual([]);
    expect(await f.transfers.get(f.b, sent.id)).toBeNull();
  });

  it('sends no more than is available, between active locations of the shop', async () => {
    const [small, medium] = variants as [string, string];
    expect(
      errorsOf(
        await send([
          [small, 11],
          [medium, 2],
        ]),
      ),
    ).toEqual([['input.lines.0.quantity', 'INVALID']]);
    const short = await send([[small, 11]]);
    expect(!short.ok && short.errors[0]!.message).toBe(
      "Only 10 available at Warehouse; can't send 11",
    );
    expect(await levelAt(medium, warehouse)).toMatchObject({ onHand: 3 });
    expect(errorsOf(await send([[small, 1]], warehouse, warehouse))).toEqual([
      ['input.destinationId', 'INVALID'],
    ]);
    expect(
      errorsOf(
        await send([
          [small, 1],
          [small, 2],
        ]),
      ),
    ).toEqual([['input.lines.1', 'INVALID']]);
    expect(errorsOf(await send([]))).toEqual([['input.lines', 'BLANK']]);
    expect(errorsOf(await send([[newId(), 1]]))).toEqual([
      ['input.lines.0.inventoryItemId', 'NOT_FOUND'],
    ]);
    const closed = await f.location(f.a, 'Closed');
    unwrap(await f.locations.deactivate(f.a, closed.id));
    expect(errorsOf(await send([[small, 1]], warehouse, closed))).toEqual([
      ['input.destinationId', 'INVALID'],
    ]);
    expect(
      errorsOf(
        await f.transfers.create(f.b, {
          originId: warehouse.id,
          destinationId: store.id,
          lines: [{ inventoryItemId: small, quantity: 1 }],
        }),
      ),
    ).toEqual([
      ['input.originId', 'NOT_FOUND'],
      ['input.destinationId', 'NOT_FOUND'],
      ['input.lines.0.inventoryItemId', 'NOT_FOUND'],
    ]);
    // Nothing was sent, and no number taken.
    expect(unwrap(await send([[small, 1]])).number).toBe(1);
  });

  it('cancels what has not arrived, back where it left, and holds both locations in use until then', async () => {
    const [small] = variants as [string];
    const sent = unwrap(await send([[small, 6]]));
    expect(errorsOf(await f.locations.deactivate(f.a, store.id))).toEqual([
      ['locationId', 'IN_USE'],
    ]);
    unwrap(
      await f.transfers.receive(f.a, sent.id, {
        lines: [{ lineId: sent.lines[0]!.id, quantity: 2 }],
      }),
    );
    const cancelled = unwrap(await f.transfers.cancel(f.a, sent.id));
    expect(cancelled).toMatchObject({ status: 'cancelled', closedAt: expect.any(Date) });
    expect(cancelled.lines[0]).toMatchObject({ quantity: 6, received: 2 });
    expect(await levelAt(small, warehouse)).toMatchObject({ onHand: 8 });
    expect(await levelAt(small, store)).toMatchObject({ onHand: 2 });
    expect((await f.inventory.history(f.a, small, { first: 1 })).items[0]).toMatchObject({
      delta: 4,
      reason: 'movement_canceled',
      location: { id: warehouse.id },
    });
    expect(errorsOf(await f.transfers.cancel(f.a, sent.id))).toEqual([['id', 'INVALID']]);
    expect(errorsOf(await f.transfers.cancel(f.b, sent.id))).toEqual([['id', 'NOT_FOUND']]);
    // Nothing on its way: the store, once empty, can be taken out of use.
    unwrap(await stock(small, 0, store));
    unwrap(await f.locations.deactivate(f.a, store.id));
  });

  it('prints a transfer to go with the stock, in the language chosen (ADR-362)', async () => {
    const [small, medium] = variants as [string, string];
    const sent = unwrap(
      await f.transfers.create(f.a, {
        originId: warehouse.id,
        destinationId: store.id,
        reference: 'Bilty 4410',
        note: 'Two cartons',
        lines: [
          { inventoryItemId: small, quantity: 6 },
          { inventoryItemId: medium, quantity: 3 },
        ],
      }),
    );
    const both = (await f.transfers.document(f.a, sent.id, 'bilingual'))!;
    expect(both).toMatchObject({ title: 'Stock transfer T-1', fileName: 'transfer-1.html' });
    for (const shown of [
      'Stock transfer',
      'اسٹاک کی منتقلی',
      'T-1',
      'Bilty 4410',
      'Warehouse',
      'Karachi store',
      'Lawn suit',
      'Two cartons',
      'Received by',
    ]) {
      expect(both.html).toContain(shown);
    }
    expect(both.html).not.toContain('class="banner"');
    const urdu = (await f.transfers.document(f.a, sent.id, 'urdu'))!;
    expect(urdu.html).toContain('اسٹاک کی منتقلی');
    expect(urdu.html).not.toContain('>Stock transfer<');
    // Once cancelled, it says so.
    unwrap(await f.transfers.cancel(f.a, sent.id));
    expect((await f.transfers.document(f.a, sent.id, 'english'))!.html).toContain(
      '<p class="banner">Cancelled</p>',
    );
    expect(await f.transfers.document(f.b, sent.id, 'english')).toBeNull();
  });
});
