import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import type { MutationResult, TenantContext } from '@hatti/api';
import { SecretBox } from '@hatti/crypto';
import { SegmentFieldRegistry, SegmentService } from '@hatti/customers/public';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AutomationsService, automationOnIn, codPrepaidCreditIn } from './automations.service.js';
import { MessagesService } from './messages.service.js';
import { FakeGraph, NUMBER, WABA } from './test-support.js';
import { WhatsAppAccountsService } from './whatsapp-accounts.service.js';
import { WhatsAppTemplatesService } from './whatsapp-templates.service.js';

const server = testDatabaseServer();

function unwrap<T>(result: MutationResult<T>): T {
  if (!result.ok) throw new Error(`Expected success, got ${JSON.stringify(result.errors)}`);
  return result.value;
}

function tenant(shopId: string): TenantContext {
  return {
    shopId,
    currency: 'PKR',
    actor: { kind: 'app', tokenId: newId() },
    scopes: new Set(['write_settings', 'write_marketing_events']),
  };
}

const DAY = 86_400_000;

describe.skipIf(!server)("A shop's marketing automations (MKT-04, ADR-425)", () => {
  let testDb: TestDatabase;
  let db: Database;
  let admin: pg.Client;
  let graph: FakeGraph;
  let templates: WhatsAppTemplatesService;
  let automations: AutomationsService;
  const box = new SecretBox([{ id: 'k1', key: randomBytes(32) }]);
  const a = tenant(newId());
  let approved: string;
  let pending: string;
  /** Each customer's last order, as the orders module's facts would say. */
  const lastOrders: { customerId: string; at: Date }[] = [];

  const customer = async (phone: string, consent: string, lastOrderDaysAgo?: number) => {
    const id = newId();
    await admin.query(
      `WITH added AS (
         INSERT INTO customers.customers (shop_id, id, phone, name, whatsapp_consent)
         VALUES ($1, $2, $3, 'Ayesha Khan', $4)
         RETURNING shop_id, id, phone)
       INSERT INTO customers.customer_phones (shop_id, phone, customer_id)
       SELECT shop_id, phone, id FROM added`,
      [a.shopId, id, phone, consent],
    );
    if (lastOrderDaysAgo !== undefined) {
      lastOrders.push({ customerId: id, at: new Date(Date.now() - lastOrderDaysAgo * DAY) });
    }
    return { id, phone, name: 'Ayesha Khan' };
  };

  const automationMessages = async () =>
    (
      await admin.query<{
        customer_id: string;
        channel: string;
        language: string;
        variables: Record<string, string>;
      }>(
        `SELECT customer_id, channel, language, variables FROM messaging.messages
          WHERE shop_id = $1 AND kind = 'automation' ORDER BY created_at, id`,
        [a.shopId],
      )
    ).rows;

  beforeAll(async () => {
    testDb = await createTestDatabase(server!);
    db = new Database({
      appUrl: testDb.appUrl,
      systemUrl: testDb.systemUrl,
      applicationName: 'automations-test',
    });
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'A')`, [a.shopId]);
    graph = new FakeGraph();
    const accounts = new WhatsAppAccountsService(db, box, {
      appId: '1234567890',
      appSecret: 'app-secret',
      configurationId: '987654321',
      baseUrl: await graph.start(),
      version: 'v26.0',
    });
    templates = new WhatsAppTemplatesService(db, accounts);
    // The orders module's last order, as its facts give it (ADR-024).
    const registry = new SegmentFieldRegistry();
    registry.register({
      key: 'order_facts',
      query: () =>
        sql`SELECT * FROM (VALUES ${sql.join(
          [
            sql`(${newId()}::uuid, now())`,
            ...lastOrders.map(
              (each) => sql`(${each.customerId}::uuid, ${each.at.toISOString()}::timestamptz)`,
            ),
          ],
          sql`, `,
        )}) AS facts (customer_id, last_order_at)`,
      fields: [
        {
          name: 'last_order_date',
          type: 'date',
          description: 'When they last ordered.',
          example: 'last_order_date < -60d',
          label: 'Last order',
          sql: sql`order_facts.last_order_at`,
        },
      ],
    });
    automations = new AutomationsService(
      db,
      templates,
      new SegmentService(db, registry),
      new MessagesService(db),
    );

    unwrap(
      await accounts.connect(a, {
        code: 'good-code',
        businessAccountId: WABA,
        phoneNumberId: NUMBER,
      }),
    );
    approved = unwrap(
      await templates.create(a, {
        name: 'welcome_offer',
        language: 'en',
        body: 'Welcome {{1}}! Here is 10% off your next order.',
      }),
    ).id;
    await templates.recordStatuses([
      { metaTemplateId: graph.templates[0]!.id, event: 'APPROVED', reason: null },
    ]);
    pending = unwrap(
      await templates.create(a, { name: 'miss_you', language: 'en', body: 'We miss you!' }),
    ).id;
  });

  afterAll(async () => {
    await graph?.stop();
    await db?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it("is off until the shop turns it on, with a template Meta approved and a win-back's days", async () => {
    expect(await automations.list(a)).toEqual([
      {
        kind: 'welcome',
        enabled: false,
        template: null,
        afterDays: null,
        creditAmount: null,
        updatedAt: null,
      },
      {
        kind: 'win_back',
        enabled: false,
        template: null,
        afterDays: 60,
        creditAmount: null,
        updatedAt: null,
      },
      {
        kind: 'back_in_stock',
        enabled: false,
        template: null,
        afterDays: null,
        creditAmount: null,
        updatedAt: null,
      },
      {
        kind: 'cod_prepaid',
        enabled: false,
        template: null,
        afterDays: null,
        creditAmount: 100_00n,
        updatedAt: null,
      },
    ]);
    const code = async (result: Promise<MutationResult<unknown>>) => {
      const done = await result;
      return done.ok ? 'ok' : `${done.errors[0]!.code}: ${done.errors[0]!.message}`;
    };
    expect(await code(automations.update(a, 'welcome', { enabled: true }))).toBe(
      'BLANK: Choose the template it sends',
    );
    expect(
      await code(automations.update(a, 'welcome', { enabled: true, templateId: pending })),
    ).toBe("INVALID: Meta hasn't approved this template");
    expect(await code(automations.update(a, 'welcome', { templateId: newId() }))).toBe(
      "NOT_FOUND: No such template on the shop's number",
    );
    expect(await code(automations.update(a, 'welcome', { afterDays: 30 }))).toBe(
      'INVALID: Only a win-back waits some days',
    );
    expect(await code(automations.update(a, 'win_back', { afterDays: 7 }))).toBe(
      'INVALID: A win-back goes between 14 and 365 days after the last order',
    );
    // Back in stock sends Hatti's own template: none of the shop's, and on without one (ADR-429).
    expect(await code(automations.update(a, 'back_in_stock', { templateId: approved }))).toBe(
      "INVALID: Back in stock is sent from Hatti's number, with no template of the shop's",
    );
    expect(await automations.update(a, 'back_in_stock', { enabled: true })).toMatchObject({
      ok: true,
      value: { kind: 'back_in_stock', enabled: true, template: null },
    });
    expect(await db.tenant(a.shopId, (tx) => automationOnIn(tx, a.shopId, 'back_in_stock'))).toBe(
      true,
    );
    expect(await db.tenant(a.shopId, (tx) => automationOnIn(tx, a.shopId, 'welcome'))).toBe(false);
    // A template not yet approved can be chosen while it is off.
    expect(await code(automations.update(a, 'win_back', { templateId: pending }))).toBe('ok');

    const welcome = unwrap(
      await automations.update(a, 'welcome', { enabled: true, templateId: approved }),
    );
    expect(welcome).toMatchObject({
      kind: 'welcome',
      enabled: true,
      template: { id: approved, name: 'welcome_offer', status: 'approved' },
      afterDays: null,
    });
    const { rows } = await admin.query<{ event_type: string; payload: Record<string, unknown> }>(
      `SELECT event_type, payload FROM platform.outbox_events
        WHERE shop_id = $1 AND event_type = 'marketing_automation.updated' ORDER BY occurred_at`,
      [a.shopId],
    );
    expect(rows.map((row) => row.payload)).toEqual([
      expect.objectContaining({ kind: 'back_in_stock', enabled: true }),
      expect.objectContaining({ kind: 'win_back', enabled: false }),
      expect.objectContaining({ kind: 'welcome', enabled: true }),
    ]);
    const audit = await admin.query<{ action: string }>(
      `SELECT action FROM platform.audit_log WHERE shop_id = $1`,
      [a.shopId],
    );
    expect(audit.rows.map((row) => row.action)).toContain('marketing_automation.updated');
  });

  it("offers store credit for paying a COD order online, from Hatti's number, as much as the shop sets (ADR-432)", async () => {
    const code = async (result: Promise<MutationResult<unknown>>) => {
      const done = await result;
      return done.ok ? 'ok' : `${done.errors[0]!.code}: ${done.errors[0]!.message}`;
    };
    const credit = () => db.tenant(a.shopId, (tx) => codPrepaidCreditIn(tx, a.shopId));
    expect(await credit()).toBeNull();
    expect(await code(automations.update(a, 'cod_prepaid', { templateId: approved }))).toBe(
      "INVALID: COD to prepaid is sent from Hatti's number, with no template of the shop's",
    );
    expect(await code(automations.update(a, 'welcome', { creditAmount: '100' }))).toBe(
      'INVALID: Only COD to prepaid offers store credit',
    );
    for (const amount of ['5', '20000', 'lots']) {
      expect(await code(automations.update(a, 'cod_prepaid', { creditAmount: amount }))).toMatch(
        /^INVALID: /,
      );
    }
    // On with Rs 100 unless the shop says otherwise.
    expect(unwrap(await automations.update(a, 'cod_prepaid', { enabled: true }))).toMatchObject({
      kind: 'cod_prepaid',
      enabled: true,
      template: null,
      creditAmount: 100_00n,
    });
    expect(await credit()).toBe(100_00n);
    unwrap(await automations.update(a, 'cod_prepaid', { creditAmount: '250' }));
    expect(await credit()).toBe(250_00n);
    // Off, it offers nothing; on again, as much as before.
    unwrap(await automations.update(a, 'cod_prepaid', { enabled: false }));
    expect(await credit()).toBeNull();
    expect(unwrap(await automations.update(a, 'cod_prepaid', { enabled: true })).creditAmount).toBe(
      250_00n,
    );
  });

  it('welcomes a customer who subscribed once, from the shop number with its template', async () => {
    const sana = await customer('+923001110010', 'subscribed');
    unwrap(await automations.update(a, 'welcome', { enabled: true, templateId: approved }));
    expect(await automations.welcome(a.shopId, sana)).toEqual(expect.any(String));
    expect(await automations.welcome(a.shopId, sana)).toBeNull();
    expect((await automationMessages()).filter((each) => each.customer_id === sana.id)).toEqual([
      {
        customer_id: sana.id,
        channel: 'whatsapp',
        language: 'en',
        variables: {
          shop: 'A',
          template: 'welcome_offer',
          automation: 'welcome',
          name: 'Ayesha',
        },
      },
    ]);

    // Off, nobody is welcomed.
    unwrap(await automations.update(a, 'welcome', { enabled: false }));
    const bilal = await customer('+923001110011', 'subscribed');
    expect(await automations.welcome(a.shopId, bilal)).toBeNull();
  });

  it('wins back the subscribed customers whose last order was its days ago, once each time they lapse', async () => {
    const lapsed = await customer('+923001110020', 'subscribed', 61);
    await customer('+923001110021', 'subscribed', 10);
    await customer('+923001110022', 'subscribed', 70);
    await customer('+923001110023', 'unsubscribed', 61);
    await customer('+923001110024', 'subscribed');
    unwrap(await automations.update(a, 'win_back', { enabled: true, templateId: approved }));
    expect(await automations.winBackShops()).toEqual([a.shopId]);

    const now = new Date();
    expect(await automations.winBack(a.shopId, now)).toBe(1);
    // The next sweeps, that day and the days after, while they are still lapsed: none again.
    expect(await automations.winBack(a.shopId, now)).toBe(0);
    expect(await automations.winBack(a.shopId, new Date(now.getTime() + DAY))).toBe(0);
    const sent = (await automationMessages()).filter((each) => each.customer_id === lapsed.id);
    expect(sent.map((each) => each.variables.automation)).toEqual(['win_back']);

    // Lapsed again, long after the last win-back: another.
    await admin.query(
      `UPDATE messaging.messages SET created_at = now() - interval '100 days'
        WHERE shop_id = $1 AND customer_id = $2`,
      [a.shopId, lapsed.id],
    );
    expect(await automations.winBack(a.shopId, new Date(now.getTime() + 2 * DAY))).toBe(1);

    // Meta pausing the template stops it.
    await admin.query("UPDATE messaging.whatsapp_templates SET status = 'paused' WHERE id = $1", [
      approved,
    ]);
    await admin.query('DELETE FROM messaging.messages WHERE shop_id = $1', [a.shopId]);
    expect(await automations.winBack(a.shopId, now)).toBe(0);
    unwrap(await automations.update(a, 'welcome', { enabled: false }));
    expect(await automations.update(a, 'win_back', { enabled: true, afterDays: 90 })).toMatchObject(
      { ok: false, errors: [{ code: 'INVALID' }] },
    );
  });
});
