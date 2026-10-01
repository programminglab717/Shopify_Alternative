import 'reflect-metadata';
import type { StaffRole, TenantContext } from '@hatti/api';
import { testDatabaseServer } from '@hatti/db/testing';
import { listAudit } from '@hatti/events';
import { newId } from '@hatti/ids';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { toBlocklistEntry, toConsentEventConnection, toCustomer } from './graphql/mappers.js';
import { customersFixture, unwrap, type CustomersFixture } from './test-support.js';

const server = testDatabaseServer();

describe.skipIf(!server)("Who sees customers' numbers", () => {
  let f: CustomersFixture;

  beforeAll(async () => {
    f = await customersFixture(server!);
  });

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
    await f.admin.query('DELETE FROM platform.audit_log');
  });

  const staff = (role: StaffRole): TenantContext => ({
    ...f.a,
    actor: {
      kind: 'staff',
      userId: newId(),
      sessionId: newId(),
      authenticatedAt: new Date(),
      role,
    },
  });

  it('masks numbers for every role but owners and managers', async () => {
    const customer = unwrap(
      await f.customers.create(f.a, {
        phone: '0300 1234567',
        marketingConsent: [{ channel: 'sms', state: 'subscribed', wording: 'Yes to SMS' }],
      }),
    );
    unwrap(await f.blocklist.add(f.a, { phone: '0300 1234567', reason: 'fake_orders' }));
    const entry = await f.db.tenant(f.a.shopId, (tx) =>
      f.blocklist.entryOf(tx, f.a.shopId, '+923001234567'),
    );
    const history = await f.customers.consentHistory(f.a, customer.id, { first: 10 });

    for (const role of ['confirmation_agent', 'packer', 'marketer', 'accountant'] as const) {
      const tenant = staff(role);
      expect(toCustomer(customer, tenant), role).toMatchObject({
        phone: '0300 ••••567',
        displayName: '0300 ••••567',
      });
      expect(toBlocklistEntry(entry!, tenant).phone).toBe('0300 ••••567');
      expect(toConsentEventConnection(history.items, false, tenant).nodes[0]!.contact).toBe(
        '0300 ••••567',
      );
    }
    for (const tenant of [f.a, staff('owner'), staff('manager')]) {
      expect(toCustomer(customer, tenant)).toMatchObject({
        phone: '+923001234567',
        displayName: '0300 1234567',
      });
    }
  });

  it('lets staff who see numbers masked search by whole numbers only', async () => {
    const customer = unwrap(await f.customers.create(f.a, { phone: '0300 1234567' }));
    unwrap(await f.blocklist.add(f.a, { phone: '0300 1234567', reason: 'fake_orders' }));
    const agent = staff('confirmation_agent');
    const found = async (tenant: TenantContext, query: string) =>
      (await f.customers.list(tenant, { first: 5, query })).items.map((item) => item.id);
    expect(await found(agent, '0300-1234567')).toEqual([customer.id]);
    // Digits anywhere in a number would let them rebuild it digit by digit.
    expect(await found(agent, '1234567')).toEqual([]);
    expect(await found(staff('manager'), '1234567')).toEqual([customer.id]);
    const blocked = async (query: string) =>
      (await f.blocklist.list(agent, { first: 5, query })).items.length;
    expect([await blocked('1234567'), await blocked('03001234567')]).toEqual([0, 1]);
  });

  it('reveals numbers to whoever asks, and logs who did', async () => {
    const customer = unwrap(
      await f.customers.create(f.a, { phone: '0300 1234567', otherPhones: ['0311 1234567'] }),
    );
    const agent = staff('confirmation_agent');
    expect(unwrap(await f.customers.revealPhones(agent, customer.id))).toEqual({
      phone: '+923001234567',
      otherPhones: ['+923111234567'],
    });
    const log = await f.db.tenant(f.a.shopId, (tx) => listAudit(tx, f.a.shopId, { first: 10 }));
    expect(log.items).toMatchObject([
      {
        action: 'customer.phone_revealed',
        subjectType: 'customer',
        subjectId: customer.id,
        actorKind: 'staff',
        actorId: agent.actor.kind === 'staff' ? agent.actor.userId : null,
        actorRole: 'confirmation_agent',
      },
    ]);
    expect(await f.customers.revealPhones(f.b, customer.id)).toMatchObject({
      ok: false,
      errors: [{ field: ['id'], code: 'NOT_FOUND' }],
    });
    // Nothing was revealed in the other shop, so nothing was logged.
    const other = await f.db.tenant(f.b.shopId, (tx) => listAudit(tx, f.b.shopId, { first: 10 }));
    expect(other.items).toEqual([]);
  });

  it('logs merges, erasures and exports too', async () => {
    const keep = unwrap(await f.customers.create(f.a, { phone: '0300 1234567' }));
    const duplicate = unwrap(await f.customers.create(f.a, { phone: '0311 1234567' }));
    unwrap(await f.data.merge(f.staff, keep.id, duplicate.id));
    unwrap(await f.transfer.export(f.staff, { query: 'customer_tags CONTAINS vip' }));
    unwrap(await f.data.erase(f.staff, keep.id));
    const log = await f.db.tenant(f.a.shopId, (tx) => listAudit(tx, f.a.shopId, { first: 10 }));
    expect(log.items.map((item) => [item.action, item.subjectType, item.details])).toEqual([
      ['customer.erased', 'customer', {}],
      [
        'customers.exported',
        'shop',
        { rows: 0, query: 'customer_tags CONTAINS vip', segmentId: null },
      ],
      [
        'customer.merged',
        'customer',
        { mergedCustomerId: expect.stringMatching(/^cus_/) as string },
      ],
    ]);
    expect(new Set(log.items.map((item) => item.actorRole))).toEqual(new Set(['manager']));
  });
});
