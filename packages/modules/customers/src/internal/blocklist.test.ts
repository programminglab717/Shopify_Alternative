import 'reflect-metadata';
import { testDatabaseServer } from '@hatti/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { toBlocklistEntry } from './graphql/mappers.js';
import { customersFixture, errorsOf, unwrap, type CustomersFixture } from './test-support.js';

const server = testDatabaseServer();

describe.skipIf(!server)('BlocklistService', () => {
  let f: CustomersFixture;

  beforeAll(async () => {
    f = await customersFixture(server!);
  });

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
  });

  it('blocks a number, noting who and why', async () => {
    const entry = unwrap(
      await f.blocklist.add(f.staff, {
        phone: '0300-1234567',
        reason: 'refused_deliveries',
        note: ' Refused 3 parcels in May ',
      }),
    );
    expect(entry).toMatchObject({
      phone: '+923001234567',
      reason: 'refused_deliveries',
      note: 'Refused 3 parcels in May',
      actorKind: 'staff',
      version: 1,
    });
    expect(f.staff.actor.kind === 'staff' && entry.actorId).toBe(
      f.staff.actor.kind === 'staff' && f.staff.actor.userId,
    );
    expect(toBlocklistEntry(entry, f.a)).toMatchObject({
      id: expect.stringMatching(/^blk_/),
      reason: 'REFUSED_DELIVERIES',
    });
    expect(await f.outbox()).toEqual([
      {
        event_type: 'blocklist_entry.created',
        aggregate_type: 'blocklist_entry',
        aggregate_id: entry.id,
        payload: { phone: '+923001234567', reason: 'refused_deliveries', version: 1 },
      },
    ]);
    expect(
      await f.db.tenant(f.a.shopId, (tx) => f.blocklist.entryOf(tx, f.a.shopId, entry.phone)),
    ).toEqual(entry);
    expect((await f.blocklist.entriesOf(f.a, ['+923001234567', '+923217654321'])).size).toBe(1);

    // A number can be blocked without being a customer.
    expect(await f.customers.byPhones(f.a, ['+923001234567'])).toEqual(new Map());
  });

  it('replaces the reason and note when a number is blocked again', async () => {
    const first = unwrap(
      await f.blocklist.add(f.a, { phone: '03001234567', reason: 'fake_orders', note: 'Prank' }),
    );
    const again = unwrap(
      await f.blocklist.add(f.staff, { phone: '+92 300 1234567', reason: 'fraud' }),
    );
    expect(again).toMatchObject({
      id: first.id,
      reason: 'fraud',
      note: '',
      actorKind: 'staff',
      version: 2,
    });
    expect((await f.outbox()).map((event) => [event.event_type, event.payload])).toEqual([
      ['blocklist_entry.created', { phone: '+923001234567', reason: 'fake_orders', version: 1 }],
      [
        'blocklist_entry.updated',
        { phone: '+923001234567', reason: 'fraud', changed: ['reason', 'note'], version: 2 },
      ],
    ]);

    // The same again changes nothing.
    const same = unwrap(await f.blocklist.add(f.a, { phone: '03001234567', reason: 'fraud' }));
    expect(same).toMatchObject({ version: 2, actorKind: 'staff' });
    expect(await f.outbox()).toHaveLength(2);
  });

  it('rejects numbers that are not Pakistani mobiles, and long notes', async () => {
    expect(
      errorsOf(
        await f.blocklist.add(f.a, {
          phone: '021-111-222-333',
          reason: 'other',
          note: 'x'.repeat(1_001),
        }),
      ),
    ).toEqual([
      ['input.phone', 'INVALID'],
      ['input.note', 'TOO_LONG'],
    ]);
    expect(errorsOf(await f.blocklist.add(f.a, { phone: '', reason: 'other' }))).toEqual([
      ['input.phone', 'BLANK'],
    ]);
  });

  it('unblocks a number', async () => {
    const entry = unwrap(await f.blocklist.add(f.a, { phone: '03001234567', reason: 'abuse' }));
    expect(unwrap(await f.blocklist.remove(f.a, '0300 1234567'))).toEqual({
      id: entry.id,
      phone: '+923001234567',
    });
    expect((await f.outbox()).at(-1)).toEqual({
      event_type: 'blocklist_entry.deleted',
      aggregate_type: 'blocklist_entry',
      aggregate_id: entry.id,
      payload: { phone: '+923001234567' },
    });
    const missing = await f.blocklist.remove(f.a, '03001234567');
    expect(errorsOf(missing)).toEqual([['phone', 'NOT_FOUND']]);
    expect(!missing.ok && missing.errors[0]!.message).toBe('0300 1234567 is not on the blocklist');
    expect(errorsOf(await f.blocklist.remove(f.a, 'abc'))).toEqual([['phone', 'INVALID']]);
  });

  it('lists blocked numbers, most recent first, and finds them by number', async () => {
    const one = unwrap(await f.blocklist.add(f.a, { phone: '03001234567', reason: 'fraud' }));
    const two = unwrap(await f.blocklist.add(f.a, { phone: '03335551234', reason: 'abuse' }));
    const ids = async (query?: string) =>
      (await f.blocklist.list(f.a, { first: 10, query })).items.map((item) => item.id);

    expect(await ids()).toEqual([two.id, one.id]);
    expect(await ids('0300-1234567')).toEqual([one.id]);
    expect(await ids('1234')).toEqual([two.id, one.id]);
    expect(await ids('Ayesha')).toEqual([]);

    const page = await f.blocklist.list(f.a, { first: 1 });
    expect(page).toMatchObject({ hasNextPage: true, items: [{ id: two.id }] });
    expect((await f.blocklist.list(f.a, { first: 1, after: two.id })).items).toMatchObject([
      { id: one.id },
    ]);
  });

  it("keeps each shop's blocklist to itself", async () => {
    unwrap(await f.blocklist.add(f.a, { phone: '03001234567', reason: 'fraud' }));
    expect((await f.blocklist.list(f.b, { first: 10 })).items).toEqual([]);
    expect((await f.blocklist.entriesOf(f.b, ['+923001234567'])).size).toBe(0);
    expect(
      await f.db.tenant(f.b.shopId, (tx) => f.blocklist.entryOf(tx, f.b.shopId, '+923001234567')),
    ).toBeNull();
    expect(errorsOf(await f.blocklist.remove(f.b, '03001234567'))).toEqual([
      ['phone', 'NOT_FOUND'],
    ]);
    // Shop B blocks the same number on its own.
    unwrap(await f.blocklist.add(f.b, { phone: '03001234567', reason: 'other' }));
    expect((await f.blocklist.list(f.a, { first: 10 })).items).toMatchObject([{ reason: 'fraud' }]);
  });

  it('blocks a number once when two requests block it at the same moment', async () => {
    const results = await Promise.all(
      (['fraud', 'abuse', 'fake_orders'] as const).map((reason) =>
        f.blocklist.add(f.a, { phone: '03001234567', reason }),
      ),
    );
    const ids = new Set(results.map((result) => unwrap(result).id));
    expect(ids.size).toBe(1);
    expect((await f.blocklist.list(f.a, { first: 10 })).items).toHaveLength(1);
  });
});
