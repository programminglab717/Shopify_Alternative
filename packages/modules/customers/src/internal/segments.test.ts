import 'reflect-metadata';
import { testDatabaseServer } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SegmentFieldRegistry } from './segment-fields.js';
import { SegmentQueryError } from './segment-query.js';
import { SegmentService } from './segment.service.js';
import { customersFixture, errorsOf, unwrap, type CustomersFixture } from './test-support.js';

const server = testDatabaseServer();

describe.skipIf(!server)('SegmentService', () => {
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

  /** The reason a query fails to compile. */
  async function failure(service: SegmentService, query: string): Promise<string> {
    try {
      await service.count(f.a, query);
    } catch (error) {
      if (error instanceof SegmentQueryError) return error.message;
      throw error;
    }
    throw new Error(`Expected "${query}" to fail`);
  }

  it('saves segments, checking their queries', async () => {
    const segment = unwrap(
      await f.segments.create(f.a, {
        name: ' Wholesale ',
        query: " customer_tags CONTAINS 'wholesale' ",
      }),
    );
    expect(segment).toMatchObject({
      name: 'Wholesale',
      query: "customer_tags CONTAINS 'wholesale'",
      version: 1,
    });
    expect(await f.segments.get(f.a, segment.id)).toEqual(segment);
    expect(await f.outbox()).toEqual([
      {
        event_type: 'segment.created',
        aggregate_type: 'segment',
        aggregate_id: segment.id,
        payload: { version: 1 },
      },
    ]);

    // Names are unique ignoring case; queries must check; both problems are reported at once.
    expect(
      errorsOf(await f.segments.create(f.a, { name: 'WHOLESALE', query: 'blocked = true' })),
    ).toEqual([['name', 'TAKEN']]);
    const bad = await f.segments.create(f.a, { name: ' ', query: "tags CONTAINS 'vip'" });
    expect(bad).toEqual({
      ok: false,
      errors: [
        { field: ['name'], code: 'BLANK', message: "Name can't be blank" },
        {
          field: ['query'],
          code: 'INVALID',
          message: 'Unknown field "tags". Did you mean customer_tags? (at character 1)',
        },
      ],
    });
    // Another shop has names of its own.
    unwrap(await f.segments.create(f.b, { name: 'Wholesale', query: 'blocked = false' }));
  });

  it('renames segments, changes their queries and deletes them', async () => {
    const segment = unwrap(await f.segments.create(f.a, { name: 'VIP', query: 'blocked = false' }));
    await f.admin.query('DELETE FROM platform.outbox_events');

    const renamed = unwrap(
      await f.segments.update(f.a, segment.id, {
        name: 'VIP customers',
        query: "customer_tags CONTAINS 'vip'",
      }),
    );
    expect(renamed).toMatchObject({ name: 'VIP customers', version: 2 });
    expect(
      unwrap(await f.segments.update(f.a, segment.id, { name: 'VIP customers' })).version,
    ).toBe(2);
    expect(errorsOf(await f.segments.update(f.a, segment.id, { query: 'blocked > 1' }))).toEqual([
      ['query', 'INVALID'],
    ]);
    expect(errorsOf(await f.segments.update(f.a, segment.id, { name: null }))).toEqual([
      ['name', 'BLANK'],
    ]);
    unwrap(await f.segments.create(f.a, { name: 'Blocked', query: 'blocked = true' }));
    expect(errorsOf(await f.segments.update(f.a, segment.id, { name: 'blocked' }))).toEqual([
      ['name', 'TAKEN'],
    ]);

    // Another shop can't see, change or delete it.
    expect(await f.segments.get(f.b, segment.id)).toBeNull();
    expect((await f.segments.list(f.b, { first: 10 })).items).toEqual([]);
    expect(errorsOf(await f.segments.update(f.b, segment.id, { name: 'X' }))).toEqual([
      ['id', 'NOT_FOUND'],
    ]);
    expect(errorsOf(await f.segments.delete(f.b, segment.id))).toEqual([['id', 'NOT_FOUND']]);

    const list = await f.segments.list(f.a, { first: 1 });
    expect(list).toMatchObject({ hasNextPage: true, items: [{ name: 'Blocked' }] });
    expect(unwrap(await f.segments.delete(f.a, segment.id))).toEqual({ id: segment.id });
    expect(errorsOf(await f.segments.delete(f.a, segment.id))).toEqual([['id', 'NOT_FOUND']]);
    expect(errorsOf(await f.segments.update(f.a, newId(), { name: 'X' }))).toEqual([
      ['id', 'NOT_FOUND'],
    ]);
    expect((await f.outbox()).map((event) => [event.event_type, event.payload])).toEqual([
      ['segment.updated', { changed: ['name', 'query'], version: 2 }],
      ['segment.created', { version: 1 }],
      ['segment.deleted', {}],
    ]);
  });

  it('finds customers by their tags, when they were added and whether they are blocked', async () => {
    const vip = unwrap(
      await f.customers.create(f.a, { phone: '03001234567', tags: ['VIP', 'wholesale'] }),
    );
    const regular = unwrap(await f.customers.create(f.a, { phone: '03217654321', tags: ['vip'] }));
    const blocked = unwrap(await f.customers.create(f.a, { phone: '03335551234' }));
    unwrap(await f.blocklist.add(f.a, { phone: '03335551234', reason: 'fraud' }));
    unwrap(await f.customers.create(f.b, { phone: '03001234567', tags: ['vip'] }));
    // 20:00 UTC on 15 January is 01:00 on 16 January in Pakistan.
    await f.admin.query(
      `UPDATE customers.customers SET created_at = '2026-01-15 20:00:00+00' WHERE id = $1`,
      [blocked.id],
    );
    const ids = async (query: string) =>
      (await f.segments.members(f.a, query, { first: 10 })).items.map((item) => item.id);

    expect(await ids("customer_tags CONTAINS 'vip'")).toEqual([regular.id, vip.id]);
    expect(await ids('customer_tags NOT CONTAINS vip')).toEqual([blocked.id]);
    expect(await ids("customer_tags CONTAINS 'VIP' AND customer_tags CONTAINS wholesale")).toEqual([
      vip.id,
    ]);
    expect(await ids('blocked = true')).toEqual([blocked.id]);
    expect(await ids('blocked != true')).toEqual([regular.id, vip.id]);
    expect(await ids('customer_added_date = 2026-01-16')).toEqual([blocked.id]);
    expect(await ids('customer_added_date = 2026-01-15')).toEqual([]);
    expect(await ids('customer_added_date >= today')).toEqual([regular.id, vip.id]);
    expect(await ids('customer_added_date BETWEEN -1y AND yesterday')).toEqual([blocked.id]);
    expect(await ids('NOT (customer_tags CONTAINS vip OR blocked = true)')).toEqual([]);
    expect(await ids('customer_added_date < -2w OR customer_tags CONTAINS wholesale')).toEqual([
      blocked.id,
      vip.id,
    ]);
    expect(await f.segments.count(f.a, "customer_tags CONTAINS 'vip'")).toBe(2);
    expect(await f.segments.count(f.b, "customer_tags CONTAINS 'vip'")).toBe(1);

    const page = await f.segments.members(f.a, 'blocked = false', { first: 1 });
    expect(page).toMatchObject({ hasNextPage: true, items: [{ id: regular.id }] });
    expect(page.items[0]!.createdAt).toBeInstanceOf(Date);
    const rest = await f.segments.members(f.a, 'blocked = false', { first: 1, after: regular.id });
    expect(rest).toMatchObject({ hasNextPage: false, items: [{ id: vip.id }] });
  });

  it('checks each value and operator against its field', async () => {
    expect(await failure(f.segments, "customer_tags = 'vip'")).toBe(
      'customer_tags is a list: use CONTAINS, NOT CONTAINS (at character 1)',
    );
    expect(await failure(f.segments, 'blocked = yes')).toBe(
      'blocked takes true or false (at character 11)',
    );
    expect(await failure(f.segments, 'blocked IN (true)')).toBe(
      'blocked is true or false: use =, != (at character 1)',
    );
    expect(await failure(f.segments, 'customer_added_date > 30')).toBe(
      'customer_added_date takes a date, like 2026-09-01, or -30d for 30 days ago ' +
        '(at character 23)',
    );
    expect(await failure(f.segments, 'customer_added_date > 2026-02-30')).toContain('takes a date');
    expect(await failure(f.segments, 'customer_added_date CONTAINS today')).toBe(
      'customer_added_date is a date: use =, !=, >, >=, <, <=, BETWEEN (at character 1)',
    );
    expect(await failure(f.segments, 'nope = 1')).toBe(
      'Unknown field "nope". Fields: customer_tags, customer_added_date, blocked, ' +
        'whatsapp_subscription_status, sms_subscription_status, email_subscription_status ' +
        '(at character 1)',
    );
  });

  it('uses the facts other modules register, as fields of their own types', async () => {
    const registry = new SegmentFieldRegistry();
    registry.register({
      key: 'phone_facts',
      query: (shopId) => sql`
        SELECT id AS customer_id, right(phone, 1)::int AS last_digit,
               CASE WHEN phone LIKE '+92300%' THEN 'Jazz' ELSE 'Other' END AS network
          FROM customers.customers WHERE shop_id = ${shopId}`,
      fields: [
        {
          name: 'last_digit',
          type: 'number',
          description: 'The last digit of the number.',
          example: 'last_digit >= 5',
          sql: sql`coalesce(phone_facts.last_digit, 0)`,
        },
        {
          name: 'digit_value',
          type: 'money',
          description: 'Rs 100 per unit of the last digit.',
          example: 'digit_value > 500',
          sql: sql`coalesce(phone_facts.last_digit, 0) * 10000`,
        },
        {
          name: 'network',
          type: 'text',
          description: 'The mobile network.',
          example: 'network = Jazz',
          sql: sql`phone_facts.network`,
          normalize: (value) => (['jazz', 'other'].includes(value.toLowerCase()) ? value : null),
          invalidValue: 'is not a network',
        },
      ],
    });
    expect(() => registry.register({ key: 'phone_facts', query: () => sql``, fields: [] })).toThrow(
      'duplicate',
    );
    expect(() => registry.register({ key: 'Bad Key', query: () => sql``, fields: [] })).toThrow();
    expect(registry.fields().map((field) => field.name)).toEqual([
      'customer_tags',
      'customer_added_date',
      'blocked',
      'whatsapp_subscription_status',
      'sms_subscription_status',
      'email_subscription_status',
      'last_digit',
      'digit_value',
      'network',
    ]);

    const service = new SegmentService(f.db, registry);
    const jazz = unwrap(await f.customers.create(f.a, { phone: '03001234567' }));
    const other = unwrap(await f.customers.create(f.a, { phone: '03217654324' }));
    const ids = async (query: string) =>
      (await service.members(f.a, query, { first: 10 })).items.map((item) => item.id);

    expect(await ids('last_digit >= 5')).toEqual([jazz.id]);
    expect(await ids('last_digit BETWEEN 1 AND 4')).toEqual([other.id]);
    expect(await ids('network = JAZZ')).toEqual([jazz.id]);
    expect(await ids('network IN (jazz, other) AND NOT network = jazz')).toEqual([other.id]);
    expect(await ids('network NOT IN (jazz)')).toEqual([other.id]);
    expect(await ids("digit_value >= '700.00'")).toEqual([jazz.id]);
    expect(await ids('digit_value < 700')).toEqual([other.id]);
    expect(await ids('network != other AND blocked = false')).toEqual([jazz.id]);

    expect(await failure(service, 'network = zong')).toBe(
      '"zong" is not a network (at character 11)',
    );
    expect(await failure(service, 'network > jazz')).toBe(
      'network is text: use =, !=, IN, NOT IN (at character 1)',
    );
    expect(await failure(service, 'network = 5')).toBe(
      "network takes text; put it in quotes, like '5' (at character 11)",
    );
    expect(await failure(service, 'last_digit = 1.5')).toBe(
      'last_digit takes a whole number, like 2 (at character 14)',
    );
    expect(await failure(service, 'digit_value > lots')).toBe(
      "digit_value takes an amount, like 2500 or '2,499.50' (at character 15)",
    );
    expect(await failure(service, 'last_digits > 1')).toBe(
      'Unknown field "last_digits". Did you mean last_digit? (at character 1)',
    );
  });
});
