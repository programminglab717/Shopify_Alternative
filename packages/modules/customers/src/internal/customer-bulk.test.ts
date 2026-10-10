import 'reflect-metadata';
import { testDatabaseServer } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { customersFixture, errorsOf, unwrap, type CustomersFixture } from './test-support.js';

const server = testDatabaseServer();

describe.skipIf(!server)('Customers tagged many at once (CUS-01)', () => {
  let f: CustomersFixture;
  const create = async (phone: string, name: string, tags: string[] = []) =>
    unwrap(await f.customers.create(f.a, { phone, name, tags }));

  beforeAll(async () => {
    f = await customersFixture(server!);
  });

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
  });

  it('adds tags as yet missing, in any case, each customer once, saying those refused at their place', async () => {
    const ayesha = await create('03001234567', 'Ayesha', ['VIP']);
    const bilal = await create('03211234567', 'Bilal');
    const full = await create(
      '03331234567',
      'Sana',
      Array.from({ length: 250 }, (_, index) => `tag-${index}`),
    );
    const theirs = unwrap(await f.customers.create(f.b, { phone: '03451234567', name: 'Hina' }));
    const before = (await f.outbox()).length;

    const { customers, errors } = unwrap(
      await f.customers.bulkAddTags(
        f.a,
        [ayesha.id, bilal.id, full.id, theirs.id, ayesha.id, newId()],
        ['vip', ' Eid ', 'eid'],
      ),
    );
    expect(customers.map((customer) => [customer.name, customer.tags])).toEqual([
      ['Ayesha', ['VIP', 'Eid']],
      ['Bilal', ['vip', 'Eid']],
    ]);
    expect(errors.map((error) => [error.field.join('.'), error.code])).toEqual([
      ['ids.2', 'TOO_MANY'],
      ['ids.3', 'NOT_FOUND'],
      ['ids.5', 'NOT_FOUND'],
    ]);
    expect((await f.customers.get(f.a, full.id))!.tags).toHaveLength(250);
    expect((await f.customers.get(f.b, theirs.id))!.tags).toEqual([]);
    const updated = (await f.outbox()).slice(before);
    expect(updated.map((row) => [row.event_type, row.aggregate_id, row.payload.changed])).toEqual([
      ['customer.updated', ayesha.id, ['tags']],
      ['customer.updated', bilal.id, ['tags']],
    ]);
  });

  it('takes tags off, ignoring case, telling only of those changed, and refuses no IDs, too many or no tags', async () => {
    const ayesha = await create('03001234567', 'Ayesha', ['VIP', 'Eid']);
    const bilal = await create('03211234567', 'Bilal', ['Wholesale']);
    const before = (await f.outbox()).length;

    const { customers } = unwrap(
      await f.customers.bulkRemoveTags(f.a, [ayesha.id, bilal.id], ['vip', 'EID']),
    );
    expect(customers.map((customer) => customer.tags)).toEqual([[], ['Wholesale']]);
    expect((await f.outbox()).slice(before).map((row) => row.aggregate_id)).toEqual([ayesha.id]);

    expect(errorsOf(await f.customers.bulkRemoveTags(f.a, [], ['vip']))).toEqual([
      ['ids', 'BLANK'],
    ]);
    expect(
      errorsOf(
        await f.customers.bulkAddTags(
          f.a,
          Array.from({ length: 251 }, () => newId()),
          ['vip'],
        ),
      ),
    ).toEqual([['ids', 'TOO_MANY']]);
    expect(errorsOf(await f.customers.bulkAddTags(f.a, [ayesha.id], [' ', '']))).toEqual([
      ['tags', 'BLANK'],
    ]);
  });
});
