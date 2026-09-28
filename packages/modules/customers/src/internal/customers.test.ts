import 'reflect-metadata';
import { testDatabaseServer } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { toCustomer } from './graphql/mappers.js';
import { blocklistEntries, customers } from './schema.js';
import { customersFixture, errorsOf, unwrap, type CustomersFixture } from './test-support.js';

const server = testDatabaseServer();

describe.skipIf(!server)('CustomerService', () => {
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

  it('matches the migrated tables', async () => {
    // Drizzle names every column, so a mismatch with the SQL migrations fails here.
    await f.db.tenant(f.a.shopId, async (tx) => {
      for (const table of [customers, blocklistEntries]) await tx.select().from(table).limit(0);
    });
  });

  it('adds a customer by mobile number, in any format', async () => {
    const customer = unwrap(
      await f.customers.create(f.staff, {
        phone: '0300-1234567',
        name: ' Ayesha Khan ',
        email: 'ayesha@example.com',
        note: 'Prefers WhatsApp',
        tags: ['vip', 'VIP', ' eid '],
      }),
    );
    expect(customer).toMatchObject({
      phone: '+923001234567',
      name: 'Ayesha Khan',
      email: 'ayesha@example.com',
      note: 'Prefers WhatsApp',
      tags: ['vip', 'eid'],
      version: 1,
    });
    expect(customer.createdAt).toBeInstanceOf(Date);
    expect(await f.customers.get(f.a, customer.id)).toEqual(customer);
    expect(toCustomer(customer)).toMatchObject({
      id: expect.stringMatching(/^cus_/),
      displayName: 'Ayesha Khan',
    });
    expect(await f.outbox()).toEqual([
      {
        event_type: 'customer.created',
        aggregate_type: 'customer',
        aggregate_id: customer.id,
        payload: { source: 'manual', version: 1 },
      },
    ]);

    // Only a number is needed; the number stands in for a missing name.
    const unnamed = unwrap(await f.customers.create(f.a, { phone: '+92 321 7654321' }));
    expect(unnamed).toMatchObject({ phone: '+923217654321', name: null, email: null, tags: [] });
    expect(toCustomer(unnamed).displayName).toBe('0321 7654321');
    expect((await f.outbox()).at(-1)?.payload).toEqual({ source: 'api', version: 1 });
  });

  it('rejects bad input, and a number that is already a customer', async () => {
    expect(errorsOf(await f.customers.create(f.a, { phone: ' ' }))).toEqual([
      ['input.phone', 'BLANK'],
    ]);
    expect(
      errorsOf(
        await f.customers.create(f.a, {
          phone: '042-35761234',
          name: 'x'.repeat(256),
          email: 'not-an-email',
          note: 'x'.repeat(5_001),
          tags: ['x'.repeat(256)],
        }),
      ),
    ).toEqual([
      ['input.phone', 'INVALID'],
      ['input.name', 'TOO_LONG'],
      ['input.email', 'INVALID'],
      ['input.note', 'TOO_LONG'],
      ['input.tags', 'TOO_LONG'],
    ]);

    unwrap(await f.customers.create(f.a, { phone: '03001234567' }));
    const taken = await f.customers.create(f.a, { phone: '+923001234567', name: 'Someone' });
    expect(errorsOf(taken)).toEqual([['input.phone', 'TAKEN']]);
    // Another shop has customers of its own.
    unwrap(await f.customers.create(f.b, { phone: '03001234567' }));
  });

  it('changes a profile, leaving out what is not given', async () => {
    const customer = unwrap(
      await f.customers.create(f.a, {
        phone: '03001234567',
        name: 'Ayesha',
        email: 'ayesha@example.com',
        tags: ['vip'],
      }),
    );
    await f.admin.query('DELETE FROM platform.outbox_events');

    const updated = unwrap(
      await f.customers.update(f.a, customer.id, {
        name: 'Ayesha Khan',
        email: null,
        note: 'Calls after 6 pm',
      }),
    );
    expect(updated).toMatchObject({
      phone: '+923001234567',
      name: 'Ayesha Khan',
      email: null,
      note: 'Calls after 6 pm',
      tags: ['vip'],
      version: 2,
    });
    expect((await f.outbox()).map((event) => [event.event_type, event.payload])).toEqual([
      ['customer.updated', { changed: ['name', 'email', 'note'], version: 2 }],
    ]);

    // Nothing to change: no new version, no event.
    const same = unwrap(await f.customers.update(f.a, customer.id, { name: 'Ayesha Khan' }));
    expect(same.version).toBe(2);
    expect(await f.outbox()).toHaveLength(1);

    // A new name is searchable at once.
    const found = await f.customers.list(f.a, { first: 10, query: 'khan' });
    expect(found.items.map((item) => item.id)).toEqual([customer.id]);

    const changedPhone = unwrap(
      await f.customers.update(f.a, customer.id, { phone: '0333 5551234', tags: null }),
    );
    expect(changedPhone).toMatchObject({ phone: '+923335551234', tags: [], version: 3 });
  });

  it('refuses a number that belongs to another customer, and unknown customers', async () => {
    const ayesha = unwrap(await f.customers.create(f.a, { phone: '03001234567' }));
    unwrap(await f.customers.create(f.a, { phone: '03217654321' }));
    expect(errorsOf(await f.customers.update(f.a, ayesha.id, { phone: '0321-7654321' }))).toEqual([
      ['input.phone', 'TAKEN'],
    ]);
    expect(errorsOf(await f.customers.update(f.a, ayesha.id, { phone: null }))).toEqual([
      ['input.phone', 'BLANK'],
    ]);
    expect(errorsOf(await f.customers.update(f.a, newId(), { name: 'X' }))).toEqual([
      ['id', 'NOT_FOUND'],
    ]);
    // Shop B can't change shop A's customer, nor see it.
    expect(errorsOf(await f.customers.update(f.b, ayesha.id, { name: 'X' }))).toEqual([
      ['id', 'NOT_FOUND'],
    ]);
    expect(await f.customers.get(f.b, ayesha.id)).toBeNull();
    expect((await f.customers.getMany(f.b, [ayesha.id])).size).toBe(0);
    expect((await f.customers.byPhones(f.b, ['+923001234567'])).size).toBe(0);
    expect((await f.customers.list(f.b, { first: 10 })).items).toEqual([]);
  });

  it('finds customers by number, the end of a number, name or email; newest first', async () => {
    const ayesha = unwrap(
      await f.customers.create(f.a, {
        phone: '03001234567',
        name: 'Ayesha Khan',
        email: 'ayesha@example.com',
      }),
    );
    const bilal = unwrap(await f.customers.create(f.a, { phone: '03335551234', name: 'Bilal' }));
    const sana = unwrap(await f.customers.create(f.a, { phone: '03459876543', name: 'Sana Khan' }));
    const ids = async (query?: string) =>
      (await f.customers.list(f.a, { first: 10, query })).items.map((item) => item.id);

    expect(await ids()).toEqual([sana.id, bilal.id, ayesha.id]);
    expect(await ids('+92 300 1234567')).toEqual([ayesha.id]);
    expect(await ids('۰۳۰۰۱۲۳۴۵۶۷')).toEqual([ayesha.id]);
    expect(await ids('1234')).toEqual([bilal.id, ayesha.id]);
    expect(await ids('0333')).toEqual([bilal.id]);
    expect(await ids('khan')).toEqual([sana.id, ayesha.id]);
    expect(await ids('KHAN ayesha')).toEqual([ayesha.id]);
    expect(await ids('example.com')).toEqual([ayesha.id]);
    expect(await ids('nobody')).toEqual([]);
    expect(await ids('!!')).toEqual([]);

    const first = await f.customers.list(f.a, { first: 2 });
    expect(first.items.map((item) => item.id)).toEqual([sana.id, bilal.id]);
    expect(first.hasNextPage).toBe(true);
    const rest = await f.customers.list(f.a, { first: 2, after: bilal.id });
    expect(rest.items.map((item) => item.id)).toEqual([ayesha.id]);
    expect(rest.hasNextPage).toBe(false);
  });

  it("finds or creates an order's customer, leaving existing profiles alone", async () => {
    const order = { phone: '+923001234567', name: 'Ayesha Khan', email: 'ayesha@example.com' };
    const id = await f.db.tenant(f.a.shopId, (tx) =>
      f.customers.findOrCreate(tx, f.a.shopId, order),
    );
    expect(await f.customers.get(f.a, id)).toMatchObject({
      phone: '+923001234567',
      name: 'Ayesha Khan',
      email: 'ayesha@example.com',
      version: 1,
    });
    expect((await f.outbox()).map((event) => [event.event_type, event.payload])).toEqual([
      ['customer.created', { source: 'order', version: 1 }],
    ]);
    // The name searches, as for customers staff add.
    expect((await f.customers.list(f.a, { first: 5, query: 'ayesha' })).items).toHaveLength(1);

    const again = await f.db.tenant(f.a.shopId, (tx) =>
      f.customers.findOrCreate(tx, f.a.shopId, { ...order, name: 'Ayesha K.', email: null }),
    );
    expect(again).toBe(id);
    expect(await f.customers.get(f.a, id)).toMatchObject({ name: 'Ayesha Khan', version: 1 });
    expect(await f.outbox()).toHaveLength(1);

    // The same number in another shop is another customer.
    const other = await f.db.tenant(f.b.shopId, (tx) =>
      f.customers.findOrCreate(tx, f.b.shopId, order),
    );
    expect(other).not.toBe(id);
  });

  it('gives orders placed at the same moment by a new number one customer', async () => {
    const order = { phone: '+923001234567', name: 'Ayesha Khan', email: null };
    const ids = await Promise.all(
      Array.from({ length: 5 }, () =>
        f.db.tenant(f.a.shopId, (tx) => f.customers.findOrCreate(tx, f.a.shopId, order)),
      ),
    );
    expect(new Set(ids).size).toBe(1);
    const { rows } = await f.admin.query('SELECT count(*)::int AS n FROM customers.customers');
    expect(rows[0].n).toBe(1);
  });
});
