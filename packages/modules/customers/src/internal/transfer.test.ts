import 'reflect-metadata';
import { parseCsv } from '@hatti/csv';
import { testDatabaseServer } from '@hatti/db/testing';
import { toPublicId } from '@hatti/ids';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { customersFixture, errorsOf, unwrap, type CustomersFixture } from './test-support.js';

const server = testDatabaseServer();

/** A customer export from Shopify, with the problems real files have. */
const SHOPIFY_FILE = [
  'First Name,Last Name,Email,Accepts Email Marketing,Default Address Phone,Phone,Accepts SMS Marketing,Tags,Note',
  'Ayesha,Khan,ayesha@example.com,yes,,+923001234567,no,"vip, eid",Prefers WhatsApp',
  'Bilal,Ahmed,,no,0333 5551234,,yes,,',
  'Sana,,sana@example,no,,03459876543,,,',
  'Usman,,,no,,+14155552671,,,',
  'Hira,,,,,0300-1234567,,,',
  'Zainab,,,maybe,,03224567890,,,',
  'Fatima,,,yes,,03217654321,,,',
].join('\n');

describe.skipIf(!server)('Customer import and export', () => {
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

  it("imports Shopify's export, taking the rows it can and saying why it can't take the rest", async () => {
    const result = unwrap(await f.transfer.import(f.staff, SHOPIFY_FILE));
    expect(result).toEqual({
      rows: 7,
      created: 2,
      updated: 0,
      skipped: 0,
      rowErrorCount: 5,
      dryRun: false,
      rowErrors: [
        {
          row: 4,
          column: 'Email',
          message: 'Email must be an email address, like name@example.com',
        },
        {
          row: 5,
          column: 'Phone',
          message: '"+14155552671" is not a Pakistani mobile number, like 0300 1234567',
        },
        { row: 6, column: 'Phone', message: 'The same number as row 2' },
        {
          row: 7,
          column: 'Accepts Email Marketing',
          message: '"maybe" is not yes, no, subscribed or unsubscribed',
        },
        {
          row: 8,
          column: 'Accepts Email Marketing',
          message: 'Email consent needs an email address',
        },
      ],
    });

    const ayesha = (await f.customers.byPhones(f.a, ['+923001234567'])).get('+923001234567');
    expect(ayesha).toMatchObject({
      name: 'Ayesha Khan',
      email: 'ayesha@example.com',
      tags: ['vip', 'eid'],
      note: 'Prefers WhatsApp',
      version: 1,
      consent: {
        email: { state: 'subscribed' },
        sms: { state: 'not_subscribed' },
        whatsapp: { state: 'not_subscribed' },
      },
    });
    expect((await f.customers.consentHistory(f.a, ayesha!.id, { first: 5 })).items).toMatchObject([
      {
        channel: 'email',
        state: 'subscribed',
        source: 'import',
        wording: 'Imported from a file: Accepts Email Marketing = yes',
        contact: 'ayesha@example.com',
        actorKind: 'staff',
      },
    ]);
    // Bilal's number came from his address, and he accepts SMS.
    const bilal = (await f.customers.byPhones(f.a, ['+923335551234'])).get('+923335551234');
    expect(bilal).toMatchObject({ name: 'Bilal Ahmed', consent: { sms: { state: 'subscribed' } } });

    const events = await f.outbox();
    expect(events.filter((event) => event.event_type === 'customer.created')).toHaveLength(2);
    expect(events.find((event) => event.event_type === 'customer.created')?.payload).toEqual({
      source: 'import',
      version: 1,
    });
    expect(events.find((event) => event.event_type === 'customer_import.created')?.payload).toEqual(
      {
        rows: 7,
        created: 2,
        updated: 0,
        skipped: 0,
        rowErrors: 5,
        actorKind: 'staff',
        actorId: f.staff.actor.kind === 'staff' ? f.staff.actor.userId : null,
      },
    );
  });

  it('counts what an import would do without doing it', async () => {
    const result = unwrap(await f.transfer.import(f.a, SHOPIFY_FILE, { dryRun: true }));
    expect(result).toMatchObject({ created: 2, rowErrorCount: 5, dryRun: true });
    expect((await f.customers.list(f.a, { first: 10 })).items).toEqual([]);
    expect(await f.outbox()).toEqual([]);
  });

  it('leaves customers already here as they are, unless told to overwrite them', async () => {
    const ayesha = unwrap(
      await f.customers.create(f.a, {
        phone: '03001234567',
        name: 'Ayesha',
        email: 'old@example.com',
        tags: ['old'],
        marketingConsent: [{ channel: 'email', state: 'subscribed', wording: 'Email me' }],
      }),
    );
    const file = [
      'Phone,Name,Email,Tags,WhatsApp marketing',
      '0300 1234567,Ayesha Khan,new@example.com,"vip, eid",subscribed',
      '0321 7654321,Fatima Raza,,,',
    ].join('\r\n');

    const kept = unwrap(await f.transfer.import(f.a, file));
    expect(kept).toMatchObject({ created: 1, updated: 0, skipped: 1 });
    expect(await f.customers.get(f.a, ayesha.id)).toMatchObject({ name: 'Ayesha', version: 1 });

    const overwritten = unwrap(await f.transfer.import(f.a, file, { overwrite: true }));
    expect(overwritten).toMatchObject({ created: 0, updated: 1, skipped: 1 });
    // The new address starts email consent again; WhatsApp consent is the file's.
    expect(await f.customers.get(f.a, ayesha.id)).toMatchObject({
      name: 'Ayesha Khan',
      email: 'new@example.com',
      tags: ['vip', 'eid'],
      version: 2,
      consent: {
        email: { state: 'not_subscribed' },
        whatsapp: { state: 'subscribed' },
      },
    });
    expect((await f.customers.consentHistory(f.a, ayesha.id, { first: 5 })).items).toMatchObject([
      { channel: 'whatsapp', state: 'subscribed', source: 'import' },
      {
        channel: 'email',
        state: 'not_subscribed',
        source: 'contact_changed',
        contact: 'new@example.com',
      },
      { channel: 'email', state: 'subscribed', source: 'api' },
    ]);

    // The same file again changes nothing.
    expect(unwrap(await f.transfer.import(f.a, file, { overwrite: true }))).toMatchObject({
      updated: 0,
      skipped: 2,
    });
  });

  it('refuses files it cannot read', async () => {
    expect(errorsOf(await f.transfer.import(f.a, ' '))).toEqual([['csv', 'BLANK']]);
    expect(errorsOf(await f.transfer.import(f.a, 'Phone\n'))).toEqual([['csv', 'BLANK']]);
    const noPhone = await f.transfer.import(f.a, 'Name,Email\nAyesha,a@example.com');
    expect(noPhone).toEqual({
      ok: false,
      errors: [
        {
          field: ['csv'],
          code: 'INVALID',
          message: 'The file needs a Phone column: customers are found by their mobile number',
        },
      ],
    });
    const unclosed = await f.transfer.import(f.a, 'Phone,Note\n03001234567,"never closed');
    expect(!unclosed.ok && unclosed.errors[0]!.message).toBe(
      'A quoted cell is never closed (line 2)',
    );
    const many = [
      'Phone',
      ...Array.from({ length: 5_001 }, (_, i) => `0300${String(i).padStart(7, '0')}`),
    ];
    expect(errorsOf(await f.transfer.import(f.a, many.join('\n')))).toEqual([['csv', 'TOO_MANY']]);
  });

  it('exports customers with their consent and fields, and records who took them', async () => {
    const ayesha = unwrap(
      await f.customers.create(f.a, {
        phone: '03001234567',
        name: 'Ayesha Khan',
        email: 'ayesha@example.com',
        tags: ['vip', 'eid'],
        note: '=HYPERLINK("http://evil.example")',
        marketingConsent: [
          { channel: 'whatsapp', state: 'subscribed', wording: 'Offers on WhatsApp' },
        ],
      }),
    );
    const bilal = unwrap(await f.customers.create(f.a, { phone: '03335551234' }));
    unwrap(await f.blocklist.add(f.a, { phone: '03335551234', reason: 'fraud' }));
    unwrap(await f.customers.create(f.b, { phone: '03001234567' }));
    await f.admin.query('DELETE FROM platform.outbox_events');

    const all = unwrap(await f.transfer.export(f.staff, {}));
    expect(all.rowCount).toBe(2);
    expect(all.csv.startsWith('\uFEFF')).toBe(true);
    const [header, ...rows] = parseCsv(all.csv);
    expect(header).toEqual([
      'Customer ID',
      'Phone',
      'Name',
      'Email',
      'Tags',
      'Note',
      'WhatsApp marketing',
      'SMS marketing',
      'Email marketing',
      'Customer since',
      'Blocked',
      'Exported',
    ]);
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi' }).format(new Date());
    const watermark = expect.stringMatching(
      /^usr_[0-9a-z]{26} \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
    expect(rows).toEqual([
      [
        toPublicId('customer', ayesha.id),
        '0300 1234567',
        'Ayesha Khan',
        'ayesha@example.com',
        'vip, eid',
        // A spreadsheet shows this as text instead of running it.
        `'=HYPERLINK("http://evil.example")`,
        'subscribed',
        'not_subscribed',
        'not_subscribed',
        today,
        'no',
        watermark,
      ],
      [
        toPublicId('customer', bilal.id),
        '0333 5551234',
        '',
        '',
        '',
        '',
        'not_subscribed',
        'not_subscribed',
        'not_subscribed',
        today,
        'yes',
        watermark,
      ],
    ]);
    expect(
      rows[0]![11]!.startsWith(
        toPublicId('user', f.staff.actor.kind === 'staff' ? f.staff.actor.userId : ''),
      ),
    ).toBe(true);
    expect((await f.outbox()).map((event) => [event.event_type, event.payload])).toEqual([
      [
        'customer_export.created',
        {
          rows: 2,
          query: null,
          segmentId: null,
          actorKind: 'staff',
          actorId: f.staff.actor.kind === 'staff' ? f.staff.actor.userId : null,
        },
      ],
    ]);

    // A query, or a saved segment, narrows it down.
    const vip = unwrap(await f.transfer.export(f.a, { query: "customer_tags CONTAINS 'vip'" }));
    expect(vip.rowCount).toBe(1);
    const segment = unwrap(
      await f.segments.create(f.a, { name: 'Blocked', query: 'blocked = true' }),
    );
    const blocked = unwrap(await f.transfer.export(f.a, { segmentId: segment.id }));
    expect(parseCsv(blocked.csv)[1]![1]).toBe('0333 5551234');
    expect(
      errorsOf(await f.transfer.export(f.a, { query: 'blocked', segmentId: segment.id })),
    ).toEqual([['query', 'INVALID']]);
    expect(errorsOf(await f.transfer.export(f.a, { query: 'nope = 1' }))).toEqual([
      ['query', 'INVALID'],
    ]);
    expect(errorsOf(await f.transfer.export(f.b, { segmentId: segment.id }))).toEqual([
      ['segmentId', 'NOT_FOUND'],
    ]);

    // What Hatti exports, Hatti imports: shop B takes shop A's file.
    await f.admin.query('DELETE FROM customers.customers WHERE shop_id = $1', [f.b.shopId]);
    const imported = unwrap(await f.transfer.import(f.b, all.csv));
    expect(imported).toMatchObject({ created: 2, rowErrorCount: 0 });
    expect((await f.customers.byPhones(f.b, ['+923001234567'])).get('+923001234567')).toMatchObject(
      {
        name: 'Ayesha Khan',
        tags: ['vip', 'eid'],
        consent: { whatsapp: { state: 'subscribed' } },
      },
    );
  });

  it('exports at most 10,000 customers at a time', async () => {
    await f.admin.query(
      `INSERT INTO customers.customers (shop_id, id, phone)
       SELECT $1, platform.uuidv7(), '+92300' || lpad(g::text, 7, '0')
         FROM generate_series(1, 10001) g`,
      [f.a.shopId],
    );
    const result = await f.transfer.export(f.a, {});
    expect(result).toEqual({
      ok: false,
      errors: [
        {
          field: ['query'],
          code: 'TOO_MANY',
          message:
            '10,001 customers match; export at most 10,000 at a time. Narrow it down with a segment.',
        },
      ],
    });
  });
});
