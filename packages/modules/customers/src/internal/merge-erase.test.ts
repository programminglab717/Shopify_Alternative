import 'reflect-metadata';
import type { TenantContext } from '@hatti/api';
import { testDatabaseServer } from '@hatti/db/testing';
import { listAudit } from '@hatti/events';
import { toPublicId } from '@hatti/ids';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ERASURE_WAIT_DAYS } from './customer-data.service.js';
import type { OrderCustomerDetails } from './customer.service.js';
import { customersFixture, errorsOf, unwrap, type CustomersFixture } from './test-support.js';

const server = testDatabaseServer();

const JAZZ = '+923001234567';
const ZONG = '+923111234567';
const UFONE = '+923331234567';

describe.skipIf(!server)("Customers' numbers, merging, erasure and their own export", () => {
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

  /** The customer an order with this number would belong to, as the orders module asks. */
  function customerFor(tenant: TenantContext, phone: string): Promise<string> {
    const details: OrderCustomerDetails = { phone, name: 'From an order', email: null };
    return f.db.tenant(tenant.shopId, (tx) => f.customers.findOrCreate(tx, tenant.shopId, details));
  }

  async function numbers(tenant: TenantContext, id: string): Promise<string[] | undefined> {
    return (await f.customers.phonesOf(tenant, [id])).get(id);
  }

  it('keeps other numbers, which orders and searches find the customer by', async () => {
    const ayesha = unwrap(
      await f.customers.create(f.a, {
        phone: '0300 1234567',
        otherPhones: ['0311-1234567'],
        name: 'Ayesha Khan',
      }),
    );
    expect(await numbers(f.a, ayesha.id)).toEqual([JAZZ, ZONG]);
    expect(await customerFor(f.a, ZONG)).toBe(ayesha.id);
    expect((await f.customers.byPhones(f.a, [ZONG])).get(ZONG)?.id).toBe(ayesha.id);
    const found = await f.customers.list(f.a, { first: 10, query: '0311-1234567' });
    expect(found.items.map((customer) => customer.id)).toEqual([ayesha.id]);
    // Another shop has its own customers for the same numbers.
    expect(await customerFor(f.b, ZONG)).not.toBe(ayesha.id);

    // A number is one customer's.
    expect(
      errorsOf(await f.customers.create(f.a, { phone: '0311 1234567', otherPhones: [JAZZ] })),
    ).toEqual([
      ['input.phone', 'TAKEN'],
      ['input.otherPhones.0', 'TAKEN'],
    ]);
    const bilal = unwrap(await f.customers.create(f.a, { phone: '0333 1234567' }));
    const taken = await f.customers.update(f.a, bilal.id, { otherPhones: [ZONG] });
    expect(taken).toEqual({
      ok: false,
      errors: [
        {
          field: ['input', 'otherPhones', '0'],
          code: 'TAKEN',
          message: "0311 1234567 is another customer's number",
        },
      ],
    });
    expect(
      errorsOf(
        await f.customers.create(f.a, {
          phone: '0345 1234567',
          otherPhones: ['not a number', '0345 1234567', '0301 1111111', '0301-1111111'],
        }),
      ),
    ).toEqual([
      ['input.otherPhones.0', 'INVALID'],
      ['input.otherPhones.1', 'INVALID'],
      ['input.otherPhones.3', 'INVALID'],
    ]);
    const eleven = Array.from(
      { length: 11 },
      (_, index) => `0302 00000${String(index).padStart(2, '0')}`,
    );
    expect(errorsOf(await f.customers.update(f.a, bilal.id, { otherPhones: eleven }))).toEqual([
      ['input.otherPhones', 'TOO_MANY'],
    ]);
  });

  it('changes numbers: others are replaced, and a new main number drops the old one', async () => {
    const customer = unwrap(
      await f.customers.create(f.a, {
        phone: JAZZ,
        otherPhones: [ZONG],
        marketingConsent: [{ channel: 'sms', state: 'subscribed', wording: 'Yes to SMS' }],
      }),
    );
    await f.admin.query('DELETE FROM platform.outbox_events');

    const replaced = unwrap(await f.customers.update(f.a, customer.id, { otherPhones: [UFONE] }));
    expect(replaced.version).toBe(2);
    expect(await numbers(f.a, customer.id)).toEqual([JAZZ, UFONE]);
    expect((await f.outbox()).map((event) => event.payload)).toEqual([
      { changed: ['otherPhones'], version: 2 },
    ]);
    // Zong is free again.
    expect(await customerFor(f.a, ZONG)).not.toBe(customer.id);

    // Ufone becomes the main number: Jazz goes, and so does the SMS consent given for it.
    const moved = unwrap(await f.customers.update(f.a, customer.id, { phone: UFONE }));
    expect(moved).toMatchObject({ phone: UFONE, consent: { sms: { state: 'not_subscribed' } } });
    expect(await numbers(f.a, customer.id)).toEqual([UFONE]);
    // Unless it is kept as another number.
    unwrap(await f.customers.update(f.a, customer.id, { phone: JAZZ, otherPhones: [UFONE] }));
    expect(await numbers(f.a, customer.id)).toEqual([JAZZ, UFONE]);
    expect(
      errorsOf(await f.customers.update(f.a, customer.id, { otherPhones: [UFONE, JAZZ] })),
    ).toEqual([['input.otherPhones.1', 'INVALID']]);
    unwrap(await f.customers.update(f.a, customer.id, { otherPhones: null }));
    expect(await numbers(f.a, customer.id)).toEqual([JAZZ]);
  });

  it("merges a duplicate: its numbers, tags, note and consent history; the customer's profile wins", async () => {
    const keep = unwrap(
      await f.customers.create(f.a, {
        phone: JAZZ,
        name: 'Ayesha Khan',
        tags: ['vip'],
        note: 'Prefers evening delivery',
        marketingConsent: [{ channel: 'whatsapp', state: 'subscribed', wording: 'Offers, please' }],
      }),
    );
    const duplicate = unwrap(
      await f.customers.create(f.staff, {
        phone: ZONG,
        otherPhones: [UFONE],
        name: 'Ayesha K.',
        email: 'ayesha@example.com',
        tags: ['VIP', 'eid'],
        note: 'Her second SIM',
        marketingConsent: [
          { channel: 'sms', state: 'subscribed', wording: 'Yes to SMS' },
          { channel: 'email', state: 'subscribed', wording: 'Yes to email' },
        ],
      }),
    );
    // The duplicate came first.
    await f.admin.query(
      `UPDATE customers.customers SET created_at = now() - interval '1 year' WHERE id = $1`,
      [duplicate.id],
    );
    await f.admin.query('DELETE FROM platform.outbox_events');

    const merged = unwrap(await f.data.merge(f.a, keep.id, duplicate.id));
    expect(merged).toMatchObject({
      id: keep.id,
      phone: JAZZ,
      name: 'Ayesha Khan',
      email: 'ayesha@example.com',
      tags: ['vip', 'eid'],
      note: 'Prefers evening delivery\n\nHer second SIM',
      version: 2,
      consent: {
        whatsapp: { state: 'subscribed' },
        // The SMS consent was for the duplicate's number, not the main one.
        sms: { state: 'not_subscribed' },
        // The email comes with its consent.
        email: { state: 'subscribed' },
      },
    });
    expect(merged.createdAt.getTime()).toBeLessThan(keep.createdAt.getTime() - 1000);
    expect(await numbers(f.a, keep.id)).toEqual([JAZZ, ZONG, UFONE]);
    expect(await f.customers.get(f.a, duplicate.id)).toBeNull();
    expect(await customerFor(f.a, UFONE)).toBe(keep.id);
    const history = await f.customers.consentHistory(f.a, keep.id, { first: 10 });
    expect(history.items.map((entry) => [entry.channel, entry.contact])).toEqual([
      ['email', 'ayesha@example.com'],
      ['sms', ZONG],
      ['whatsapp', JAZZ],
    ]);
    // Other modules move their data twice: before and after the numbers.
    expect(f.handler.calls).toEqual([
      `merge ${duplicate.id} into ${keep.id}`,
      `merge ${duplicate.id} into ${keep.id}`,
    ]);
    expect(await f.outbox()).toEqual([
      {
        event_type: 'customer.merged',
        aggregate_type: 'customer',
        aggregate_id: keep.id,
        payload: {
          mergedCustomerId: duplicate.id,
          version: 2,
          actorKind: 'app',
          actorId: f.a.actor.kind === 'app' ? f.a.actor.tokenId : null,
        },
      },
    ]);
  });

  it('refuses merges it cannot do', async () => {
    const one = unwrap(await f.customers.create(f.a, { phone: JAZZ }));
    const other = unwrap(await f.customers.create(f.b, { phone: ZONG }));
    expect(errorsOf(await f.data.merge(f.a, one.id, one.id))).toEqual([['duplicateId', 'INVALID']]);
    expect(errorsOf(await f.data.merge(f.a, one.id, other.id))).toEqual([
      ['duplicateId', 'NOT_FOUND'],
    ]);
    expect(errorsOf(await f.data.merge(f.a, other.id, one.id))).toEqual([
      ['customerId', 'NOT_FOUND'],
    ]);
    const many = Array.from(
      { length: 10 },
      (_, index) => `0302 00000${String(index).padStart(2, '0')}`,
    );
    const crowded = unwrap(await f.customers.create(f.a, { phone: UFONE, otherPhones: many }));
    expect(errorsOf(await f.data.merge(f.a, crowded.id, one.id))).toEqual([
      ['duplicateId', 'TOO_MANY'],
    ]);
    expect(f.handler.calls).toEqual([]);
  });

  it("erases a customer's profile, numbers and consent history", async () => {
    const customer = unwrap(
      await f.customers.create(f.a, {
        phone: JAZZ,
        otherPhones: [ZONG],
        name: 'Ayesha Khan',
        email: 'ayesha@example.com',
        marketingConsent: [{ channel: 'email', state: 'subscribed', wording: 'Yes to email' }],
      }),
    );
    await f.admin.query('DELETE FROM platform.outbox_events');

    // Not while something of theirs is under way; nothing changes.
    f.handler.blockers = ['Their orders must be closed or cancelled first; still open: #1001'];
    expect(await f.data.erase(f.a, customer.id)).toEqual({
      ok: false,
      errors: [
        {
          field: ['id'],
          code: 'IN_USE',
          message: 'Their orders must be closed or cancelled first; still open: #1001',
        },
      ],
    });
    expect(await numbers(f.a, customer.id)).toEqual([JAZZ, ZONG]);
    expect(f.handler.calls).toEqual([]);

    f.handler.blockers = [];
    expect(unwrap(await f.data.erase(f.a, customer.id))).toEqual({ id: customer.id });
    // Other modules get the numbers and email that were theirs.
    expect(f.handler.calls).toEqual([
      `erase ${customer.id} ${[JAZZ, ZONG].sort().join(',')} ayesha@example.com`,
    ]);
    expect(await f.customers.get(f.a, customer.id)).toBeNull();
    expect((await f.customers.byPhones(f.a, [JAZZ, ZONG])).size).toBe(0);
    const { rows } = await f.admin.query(
      'SELECT count(*)::int AS count FROM customers.consent_events WHERE customer_id = $1',
      [customer.id],
    );
    expect(rows[0].count).toBe(0);
    expect(await f.outbox()).toEqual([
      {
        event_type: 'customer.erased',
        aggregate_type: 'customer',
        aggregate_id: customer.id,
        payload: { actorKind: 'app', actorId: f.a.actor.kind === 'app' ? f.a.actor.tokenId : null },
      },
    ]);
    // Their next order starts a new customer.
    expect(await customerFor(f.a, JAZZ)).not.toBe(customer.id);
    expect(errorsOf(await f.data.erase(f.a, customer.id))).toEqual([['id', 'NOT_FOUND']]);
  });

  it('erases a customer once the erasure asked for is due, unless it was cancelled first', async () => {
    const ayesha = unwrap(
      await f.customers.create(f.a, { phone: JAZZ, name: 'Ayesha', email: 'ayesha@example.com' }),
    );
    const bilal = unwrap(await f.customers.create(f.a, { phone: ZONG, name: 'Bilal' }));
    await f.admin.query('DELETE FROM platform.outbox_events');
    const before = Date.now();
    const asked = unwrap(await f.data.requestErasure(f.staff, ayesha.id));
    expect(asked.dueAt.getTime() - before).toBeGreaterThan(
      (ERASURE_WAIT_DAYS * 24 - 1) * 3_600_000,
    );
    // Asking again changes nothing.
    expect(unwrap(await f.data.requestErasure(f.a, ayesha.id))).toEqual(asked);
    expect(await f.data.erasureRequestsOf(f.a, [ayesha.id, bilal.id])).toEqual(
      new Map([[ayesha.id, asked]]),
    );
    // A request made in error is cancelled; one that waits for nothing can't be.
    unwrap(await f.data.requestErasure(f.a, bilal.id));
    expect(unwrap(await f.data.cancelErasure(f.a, bilal.id))).toEqual({ id: bilal.id });
    expect(errorsOf(await f.data.cancelErasure(f.a, bilal.id))).toEqual([['id', 'INVALID']]);
    expect(errorsOf(await f.data.requestErasure(f.b, ayesha.id))).toEqual([['id', 'NOT_FOUND']]);
    // Merged away, the customer's erasure would never happen.
    expect(errorsOf(await f.data.merge(f.a, bilal.id, ayesha.id))).toEqual([
      ['duplicateId', 'INVALID'],
    ]);

    // Not before it is due, nor while something of theirs is still under way.
    expect(await f.data.eraseDue(f.a.shopId)).toEqual({ erased: 0, waiting: 0 });
    const due = new Date(asked.dueAt.getTime() + 1_000);
    f.handler.blockers = ['Their orders must be closed or cancelled first; still open: #1001'];
    expect(await f.data.eraseDue(f.a.shopId, due)).toEqual({ erased: 0, waiting: 1 });
    expect(await f.customers.get(f.a, ayesha.id)).not.toBeNull();
    f.handler.blockers = [];
    expect(await f.data.eraseDue(f.a.shopId, due)).toEqual({ erased: 1, waiting: 0 });
    expect(await f.customers.get(f.a, ayesha.id)).toBeNull();
    expect(await f.customers.get(f.a, bilal.id)).not.toBeNull();
    expect(f.handler.calls).toEqual([`erase ${ayesha.id} ${JAZZ} ayesha@example.com`]);

    // As erasing at once is, but the system's, the staff member who asked for it named.
    const staffId = f.staff.actor.kind === 'staff' ? f.staff.actor.userId : '';
    const appId = f.a.actor.kind === 'app' ? f.a.actor.tokenId : '';
    expect((await f.outbox()).map((event) => [event.event_type, event.payload])).toEqual([
      [
        'customer.erasure_requested',
        { dueAt: asked.dueAt.toISOString(), actorKind: 'staff', actorId: staffId },
      ],
      ['customer.erasure_requested', expect.objectContaining({ actorId: appId })],
      ['customer.erasure_cancelled', { actorKind: 'app', actorId: appId }],
      [
        'customer.erased',
        { actorKind: 'staff', actorId: staffId, requestedAt: asked.requestedAt.toISOString() },
      ],
    ]);
    const audit = await f.db.tenant(f.a.shopId, (tx) =>
      listAudit(tx, f.a.shopId, { first: 10, subjectId: ayesha.id }),
    );
    expect(audit.items.map((entry) => [entry.action, entry.actorRole, entry.details])).toEqual([
      ['customer.erased', 'manager', { requestedAt: asked.requestedAt.toISOString() }],
      ['customer.erasure_requested', 'manager', { dueAt: asked.dueAt.toISOString() }],
    ]);
  });

  it('lists the erasures waiting, the soonest first, a page at a time', async () => {
    const ask = async (phone: string, name: string, dueAt: string) => {
      const customer = unwrap(await f.customers.create(f.a, { phone, name }));
      unwrap(await f.data.requestErasure(f.a, customer.id));
      // Times as the database keeps them, to the microsecond: a page must not bring back the
      // one the page before it ended with.
      await f.admin.query(
        'UPDATE customers.erasure_requests SET due_at = $2 WHERE customer_id = $1',
        [customer.id, dueAt],
      );
      return customer;
    };
    const ayesha = await ask(JAZZ, 'Ayesha', '2026-10-11T10:00:00.123456Z');
    const bilal = await ask(ZONG, 'Bilal', '2026-10-11T10:00:00.123457Z');
    const sana = await ask(UFONE, 'Sana', '2026-10-10T09:00:00.5Z');
    // Another shop's are its own.
    const other = unwrap(await f.customers.create(f.b, { phone: JAZZ, name: 'Ayesha' }));
    unwrap(await f.data.requestErasure(f.b, other.id));

    const seen: [string | null, string, boolean][] = [];
    let after: { at: string; id: string } | null = null;
    for (let page = 0; page < 4; page++) {
      const { items, hasNextPage } = await f.data.waitingErasures(f.a, { first: 1, after });
      for (const item of items) seen.push([item.customer.name, item.dueAtExactly, hasNextPage]);
      if (!hasNextPage) break;
      after = { at: items[0]!.dueAtExactly, id: items[0]!.customer.id };
    }
    expect(seen).toEqual([
      ['Sana', '2026-10-10T09:00:00.500000Z', true],
      ['Ayesha', '2026-10-11T10:00:00.123456Z', true],
      ['Bilal', '2026-10-11T10:00:00.123457Z', false],
    ]);
    const all = await f.data.waitingErasures(f.a, { first: 10 });
    expect(all.items.map((item) => [item.customer.id, item.request])).toEqual([
      [sana.id, { customerId: sana.id, requestedAt: expect.any(Date), dueAt: expect.any(Date) }],
      [ayesha.id, expect.objectContaining({ customerId: ayesha.id })],
      [bilal.id, expect.objectContaining({ customerId: bilal.id })],
    ]);

    // Cancelled, or carried out, an erasure is no longer waiting.
    unwrap(await f.data.cancelErasure(f.a, bilal.id));
    expect(await f.data.eraseDue(f.a.shopId, new Date('2026-10-10T12:00:00Z'))).toEqual({
      erased: 1,
      waiting: 0,
    });
    expect(
      (await f.data.waitingErasures(f.a, { first: 10 })).items.map((item) => item.customer.name),
    ).toEqual(['Ayesha']);
  });

  it('gives a customer everything the shop keeps of them, as a file', async () => {
    const customer = unwrap(
      await f.customers.create(f.a, {
        phone: JAZZ,
        otherPhones: [ZONG],
        name: 'Ayesha Khan',
        email: 'ayesha@example.com',
        note: 'Prefers evening deliveries',
        tags: ['vip'],
        marketingConsent: [
          { channel: 'whatsapp', state: 'subscribed', wording: 'Yes to WhatsApp' },
        ],
      }),
    );
    // The shop's blocklist is its defence against fake orders, and stays out of the file.
    unwrap(
      await f.blocklist.add(f.a, { phone: ZONG, reason: 'fake_orders', note: 'Two fake orders' }),
    );
    // Other modules add their sections, such as orders.
    f.handler.sections = { orders: [{ name: '#1001' }] };

    const file = unwrap(await f.data.export(f.staff, customer.id));
    const id = toPublicId('customer', customer.id);
    expect(file.fileName).toBe(`customer-${id}.json`);
    const since = expect.stringMatching(/^\d{4}-\d\d-\d\dT[\d:.]+Z$/) as string;
    expect(JSON.parse(file.json)).toEqual({
      format: 'hatti.customer-data/1',
      exportedAt: since,
      customer: {
        id,
        name: 'Ayesha Khan',
        phone: JAZZ,
        otherPhones: [ZONG],
        email: 'ayesha@example.com',
        note: 'Prefers evening deliveries',
        tags: ['vip'],
        customerSince: customer.createdAt.toISOString(),
        marketing: {
          whatsapp: { state: 'subscribed', since },
          sms: { state: 'not_subscribed', since: null },
          email: { state: 'not_subscribed', since: null },
        },
      },
      consentHistory: [
        {
          channel: 'whatsapp',
          state: 'subscribed',
          source: 'api',
          wording: 'Yes to WhatsApp',
          contact: JAZZ,
          collectedAt: since,
        },
      ],
      // What the shop owes them in store credit, with its ledger (ADR-184): none yet.
      storeCredit: [],
      orders: [{ name: '#1001' }],
    });
    expect(file.json).toContain('\n  "customer": {\n    "id": ');
    expect(file.json).not.toContain('Two fake orders');
    // Other modules find their records by the customer's numbers and email, as erasure does.
    expect(f.handler.calls).toEqual([
      `export ${customer.id} ${[JAZZ, ZONG].sort().join(',')} ayesha@example.com`,
    ]);
    // The shop's audit log says who gave it out, and nothing of what it holds.
    const log = await f.db.tenant(f.a.shopId, (tx) =>
      listAudit(tx, f.a.shopId, { first: 10, subjectId: customer.id }),
    );
    expect(log.items.map((item) => [item.action, item.actorRole, item.details])).toEqual([
      ['customer.data_exported', 'manager', {}],
    ]);
    // Nothing of theirs changes.
    expect(await f.customers.get(f.a, customer.id)).toMatchObject({ version: customer.version });

    // A customer of another shop is not found.
    expect(errorsOf(await f.data.export(f.b, customer.id))).toEqual([['id', 'NOT_FOUND']]);
    // A module giving a section the file already has is a mistake, and nothing is given out.
    f.handler.sections = { customer: {} };
    await expect(f.data.export(f.staff, customer.id)).rejects.toThrow(
      'Customer data handler "test" exports "customer" again',
    );
  });

  it("changes the consent ledger only in the caller's shop, and only through merges and erasure", async () => {
    const customer = unwrap(
      await f.customers.create(f.a, {
        phone: JAZZ,
        marketingConsent: [{ channel: 'sms', state: 'subscribed', wording: 'Yes to SMS' }],
      }),
    );
    const other = unwrap(await f.customers.create(f.b, { phone: JAZZ }));
    const [erased, moved] = await f.db.tenant(f.b.shopId, async (tx) => [
      (
        await tx.execute<{ count: number }>(
          sql`SELECT customers.erase_consent_history(${customer.id}) AS count`,
        )
      ).rows[0]!.count,
      (
        await tx.execute<{ count: number }>(
          sql`SELECT customers.move_consent_history(${customer.id}, ${other.id}) AS count`,
        )
      ).rows[0]!.count,
    ]);
    expect([erased, moved]).toEqual([0, 0]);
    expect(await f.customers.consentHistory(f.a, customer.id, { first: 10 })).toMatchObject({
      items: [{ channel: 'sms', contact: JAZZ }],
    });
  });

  it('counts a customer as blocked when any of their numbers is', async () => {
    const customer = unwrap(await f.customers.create(f.a, { phone: JAZZ, otherPhones: [ZONG] }));
    unwrap(await f.customers.create(f.a, { phone: UFONE }));
    unwrap(await f.blocklist.add(f.a, { phone: ZONG, reason: 'fake_orders' }));
    const blocked = await f.segments.members(f.a, 'blocked = true', { first: 10 });
    expect(blocked.items.map((member) => member.id)).toEqual([customer.id]);
  });

  it('imports by main numbers only', async () => {
    unwrap(await f.customers.create(f.a, { phone: JAZZ, otherPhones: [ZONG] }));
    const result = unwrap(
      await f.transfer.import(f.a, 'Phone,Name\n0311 1234567,Ayesha\n0333 1234567,Bilal\n', {}),
    );
    expect(result).toMatchObject({
      created: 1,
      rowErrors: [
        {
          row: 2,
          column: 'Phone',
          message: '0311 1234567 is another number of a customer here; use their main number',
        },
      ],
    });
    expect(await customerFor(f.a, UFONE)).toBe(
      (await f.customers.byPhones(f.a, [UFONE])).get(UFONE)?.id,
    );
  });
});
