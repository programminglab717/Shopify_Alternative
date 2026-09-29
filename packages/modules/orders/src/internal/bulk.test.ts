import 'reflect-metadata';
import { testDatabaseServer } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { errorsOf, ordersFixture, unwrap, type OrdersFixture } from './test-support.js';

const server = testDatabaseServer();

describe.skipIf(!server)('Packing and bulk actions', () => {
  let f: OrdersFixture;
  let kurta: string;

  beforeAll(async () => {
    f = await ordersFixture(server!);
  });

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
    [kurta] = (await f.variantsOf(f.a, 'Kurta', { price: '2,000' })) as [string];
    await f.stock(f.a, kurta, 50);
  });

  const timeline = async (orderId: string, first = 1) =>
    (await f.orders.timeline(f.a, orderId, { first })).items.map((entry) => [
      entry.kind,
      entry.message,
    ]);

  it('packs confirmed orders, moving them from To pack to To book', async () => {
    const order = await f.order(f.a, [kurta]);
    expect(errorsOf(await f.orders.markPacked(f.a, order.id))).toEqual([['id', 'INVALID']]);
    unwrap(await f.orders.confirm(f.a, order.id));
    await f.admin.query('DELETE FROM platform.outbox_events');

    const packed = unwrap(await f.orders.markPacked(f.a, order.id));
    expect(packed).toMatchObject({ stage: 'to_book' });
    expect(packed.packedAt).toBeInstanceOf(Date);
    expect(await timeline(order.id)).toEqual([['packed', 'Marked as packed']]);
    expect((await f.outbox()).map((event) => [event.event_type, event.payload])).toEqual([
      ['order.updated', { changed: ['packed'], stage: 'to_book', version: packed.version }],
    ]);
    // Packing twice changes nothing.
    expect(unwrap(await f.orders.markPacked(f.a, order.id)).version).toBe(packed.version);
    expect((await f.orders.stageCounts(f.a)).get('to_book')).toBe(1);
    const toBook = await f.orders.list(f.a, { first: 5, stage: 'to_book' });
    expect(toBook.items.map((item) => item.id)).toEqual([order.id]);

    // A mistake is taken back.
    const unpacked = unwrap(await f.orders.markUnpacked(f.a, order.id));
    expect(unpacked).toMatchObject({ stage: 'to_pack', packedAt: null });
    expect(await timeline(order.id)).toEqual([['unpacked', 'Marked as not packed']]);

    // Shipping does not need packing, and packing ends once something ships.
    const prepaid = await f.order(f.a, [kurta], { paymentMethod: 'prepaid' });
    expect(prepaid.stage).toBe('to_pack');
    unwrap(await f.fulfillments.fulfill(f.a, prepaid.id, {}));
    expect(await f.orders.markPacked(f.a, prepaid.id)).toMatchObject({
      ok: false,
      errors: [{ message: 'Only orders that have not shipped can be packed' }],
    });
    const packedThenShipped = unwrap(await f.orders.markPacked(f.a, order.id));
    unwrap(await f.fulfillments.fulfill(f.a, packedThenShipped.id, {}));
    expect(errorsOf(await f.orders.markUnpacked(f.a, order.id))).toEqual([['id', 'INVALID']]);

    // A packed order that is cancelled stays packed in its history, and can't be packed again.
    const cancelled = await f.order(f.a, [kurta]);
    unwrap(await f.orders.confirm(f.a, cancelled.id));
    unwrap(await f.orders.markPacked(f.a, cancelled.id));
    unwrap(await f.orders.cancel(f.a, cancelled.id, { reason: 'customer' }));
    expect(await f.orders.markPacked(f.a, cancelled.id)).toMatchObject({
      ok: false,
      errors: [{ message: "A cancelled order can't be packed" }],
    });
    expect(await f.orders.markUnpacked(f.a, cancelled.id)).toMatchObject({
      ok: false,
      errors: [{ message: "A cancelled order can't be unpacked" }],
    });
  });

  it('acts on each order on its own, and says which ones failed', async () => {
    const [a, b, c] = [
      await f.order(f.a, [kurta]),
      await f.order(f.a, [kurta]),
      await f.order(f.a, [kurta]),
    ];
    unwrap(await f.orders.cancel(f.a, b.id, { reason: 'customer' }));
    const [shawl] = (await f.variantsOf(f.b, 'Shawl')) as [string];
    await f.stock(f.b, shawl, 5);
    const elsewhere = await f.order(f.b, [shawl]);

    // Given twice, an order counts once.
    const confirmed = unwrap(
      await f.orders.bulkConfirm(f.a, [a.id, b.id, a.id, c.id, elsewhere.id, newId()]),
    );
    expect(confirmed.orders.map((order) => [order.id, order.stage])).toEqual([
      [a.id, 'to_pack'],
      [c.id, 'to_pack'],
    ]);
    expect(confirmed.errors).toEqual([
      { field: ['ids', '1'], code: 'INVALID', message: "A cancelled order can't be confirmed" },
      { field: ['ids', '4'], code: 'NOT_FOUND', message: 'Order not found' },
      { field: ['ids', '5'], code: 'NOT_FOUND', message: 'Order not found' },
    ]);

    const packed = unwrap(await f.orders.bulkMarkPacked(f.a, [a.id, b.id, c.id]));
    expect(packed.orders.map((order) => order.stage)).toEqual(['to_book', 'to_book']);
    expect(packed.errors.map((error) => error.field)).toEqual([['ids', '1']]);

    const tagged = unwrap(await f.orders.bulkAddTags(f.a, [a.id, c.id], ['eid', 'Eid', ' vip ']));
    expect(tagged.orders.map((order) => order.tags)).toEqual([
      ['eid', 'vip'],
      ['eid', 'vip'],
    ]);
    expect(await timeline(a.id)).toEqual([['updated', 'Added the tags eid, vip']]);
    // Tags already there, in any case, change nothing.
    const again = unwrap(await f.orders.bulkAddTags(f.a, [a.id], ['EID']));
    expect(again.orders[0]!.version).toBe(tagged.orders[0]!.version);

    const untagged = unwrap(await f.orders.bulkRemoveTags(f.a, [a.id, c.id], ['EID']));
    expect(untagged.orders.map((order) => order.tags)).toEqual([['vip'], ['vip']]);
    expect(await timeline(c.id)).toEqual([['updated', 'Removed the tag eid']]);

    const before = (await f.level(f.a, kurta))!.committed;
    const cancelled = unwrap(
      await f.orders.bulkCancel(f.a, [a.id, c.id], {
        reason: 'no_response',
        staffNote: 'Eid rush',
      }),
    );
    expect(cancelled.orders.map((order) => order.stage)).toEqual(['cancelled', 'cancelled']);
    expect((await f.level(f.a, kurta))!.committed).toBe(before - 2);
    // The other shop's order is untouched.
    expect((await f.orders.get(f.b, elsewhere.id))!.stage).toBe('needs_confirmation');
  });

  it('checks what it is asked to do before doing any of it', async () => {
    const order = await f.order(f.a, [kurta]);
    expect(errorsOf(await f.orders.bulkConfirm(f.a, []))).toEqual([['ids', 'BLANK']]);
    const many = Array.from({ length: 251 }, () => newId());
    expect(errorsOf(await f.orders.bulkConfirm(f.a, many))).toEqual([['ids', 'TOO_MANY']]);
    expect(errorsOf(await f.orders.bulkAddTags(f.a, [order.id], [' ']))).toEqual([
      ['tags', 'BLANK'],
    ]);
    expect(
      errorsOf(
        await f.orders.bulkCancel(f.a, [order.id], {
          reason: 'other',
          staffNote: 'x'.repeat(5001),
        }),
      ),
    ).toEqual([['staffNote', 'TOO_LONG']]);
    expect((await f.orders.get(f.a, order.id))!.stage).toBe('needs_confirmation');
  });
});
