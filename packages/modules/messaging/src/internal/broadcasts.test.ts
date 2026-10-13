import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import type { MutationResult, TenantContext } from '@hatti/api';
import { SecretBox } from '@hatti/crypto';
import { SegmentFieldRegistry, SegmentService } from '@hatti/customers/public';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BroadcastsService, audienceQuery } from './broadcasts.service.js';
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
    scopes: new Set(['write_settings', 'write_marketing_events', 'write_segments']),
  };
}

const NOW = new Date('2026-10-13T08:00:00.000Z');

describe.skipIf(!server)('WhatsApp broadcasts (MKT-01, ADR-421)', () => {
  let testDb: TestDatabase;
  let db: Database;
  let admin: pg.Client;
  let graph: FakeGraph;
  let segments: SegmentService;
  let templates: WhatsAppTemplatesService;
  let broadcasts: BroadcastsService;
  const box = new SecretBox([{ id: 'k1', key: randomBytes(32) }]);
  const a = tenant(newId());
  const b = tenant(newId());
  let approved: string;
  let pending: string;
  let vip: string;

  /** A customer of shop A, with their WhatsApp consent and tags. */
  const customer = async (phone: string, consent: string, tags: string[] = []) => {
    const id = newId();
    await admin.query(
      `WITH added AS (
         INSERT INTO customers.customers (shop_id, id, phone, name, whatsapp_consent, tags)
         VALUES ($1, $2, $3, 'Ayesha Khan', $4, $5)
         RETURNING shop_id, id, phone)
       INSERT INTO customers.customer_phones (shop_id, phone, customer_id)
       SELECT shop_id, phone, id FROM added`,
      [a.shopId, id, phone, consent, tags],
    );
    return id;
  };

  beforeAll(async () => {
    testDb = await createTestDatabase(server!);
    db = new Database({
      appUrl: testDb.appUrl,
      systemUrl: testDb.systemUrl,
      applicationName: 'broadcasts-test',
    });
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'A'), ($2, 'B')`, [
      a.shopId,
      b.shopId,
    ]);
    graph = new FakeGraph();
    const accounts = new WhatsAppAccountsService(db, box, {
      appId: '1234567890',
      appSecret: 'app-secret',
      configurationId: '987654321',
      baseUrl: await graph.start(),
      version: 'v26.0',
    });
    templates = new WhatsAppTemplatesService(db, accounts);
    segments = new SegmentService(db, new SegmentFieldRegistry());
    broadcasts = new BroadcastsService(db, templates, segments);

    unwrap(
      await accounts.connect(a, {
        code: 'good-code',
        businessAccountId: WABA,
        phoneNumberId: NUMBER,
      }),
    );
    const sale = unwrap(
      await templates.create(a, {
        name: 'eid_sale',
        language: 'en',
        body: 'Assalam-o-Alaikum {{1}}! Eid lawn is 20% off.',
      }),
    );
    approved = sale.id;
    await templates.recordStatuses([
      { metaTemplateId: graph.templates[0]!.id, event: 'APPROVED', reason: null },
    ]);
    pending = unwrap(
      await templates.create(a, { name: 'new_drop', language: 'en', body: 'New!' }),
    ).id;
    vip = unwrap(
      await segments.create(a, { name: 'VIPs', query: "customer_tags CONTAINS 'vip'" }),
    ).id;

    await customer('+923001110001', 'subscribed', ['vip']);
    await customer('+923001110002', 'subscribed');
    await customer('+923001110003', 'unsubscribed', ['vip']);
    await customer('+923001110004', 'not_subscribed', ['vip']);
  });

  afterAll(async () => {
    await graph?.stop();
    await db?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it('reaches those who agreed to hear on WhatsApp, of a segment or of all', async () => {
    expect(audienceQuery(null)).toBe('whatsapp_subscription_status = subscribed');
    expect(audienceQuery("customer_tags CONTAINS 'vip'")).toBe(
      "(customer_tags CONTAINS 'vip') AND whatsapp_subscription_status = subscribed",
    );
    expect(unwrap(await broadcasts.recipientsOf(a, null))).toBe(2);
    expect(unwrap(await broadcasts.recipientsOf(a, vip))).toBe(1);
    expect(unwrap(await broadcasts.recipientsOf(b, null))).toBe(0);
    const unknown = await broadcasts.recipientsOf(a, newId());
    expect(unknown.ok || unknown.errors[0]!.code).toBe('NOT_FOUND');
  });

  it("schedules an approved template's broadcast, keeping its words, and refuses what can't go", async () => {
    const bad = await broadcasts.create(
      a,
      { name: ' ', templateId: approved, sendAt: new Date(NOW.getTime() - 3_600_000) },
      NOW,
    );
    expect(bad.ok || bad.errors.map((error) => [error.field.at(-1), error.code])).toEqual([
      ['name', 'BLANK'],
      ['sendAt', 'INVALID'],
    ]);
    const far = await broadcasts.create(
      a,
      { name: 'Eid', templateId: approved, sendAt: new Date(NOW.getTime() + 31 * 86_400_000) },
      NOW,
    );
    expect(far.ok || far.errors[0]!.message).toBe("Send at can't be more than 30 days ahead");
    const unapproved = await broadcasts.create(a, { name: 'Drop', templateId: pending }, NOW);
    expect(unapproved.ok || unapproved.errors[0]!.message).toBe(
      "Meta hasn't approved this template",
    );
    const otherShop = await broadcasts.create(b, { name: 'Eid', templateId: approved }, NOW);
    expect(otherShop.ok || otherShop.errors[0]!.code).toBe('NOT_FOUND');
    const noSegment = await broadcasts.create(
      a,
      { name: 'Eid', templateId: approved, segmentId: newId() },
      NOW,
    );
    expect(noSegment.ok || noSegment.errors[0]!.code).toBe('NOT_FOUND');

    const sendAt = new Date(NOW.getTime() + 86_400_000);
    const eid = unwrap(
      await broadcasts.create(
        a,
        { name: 'Eid sale', templateId: approved, segmentId: vip, sendAt },
        NOW,
      ),
    );
    expect(eid).toMatchObject({
      name: 'Eid sale',
      templateId: approved,
      templateName: 'eid_sale',
      templateLanguage: 'en',
      templateBody: 'Assalam-o-Alaikum {{1}}! Eid lawn is 20% off.',
      segmentId: vip,
      segmentName: 'VIPs',
      sendAt,
      status: 'scheduled',
      recipients: 0,
      counts: { pending: 0, sent: 0, delivered: 0, read: 0, failed: 0, skipped: 0 },
    });
    // To every customer who agreed, now.
    const now = unwrap(
      await broadcasts.create(a, { name: 'Flash sale', templateId: approved }, NOW),
    );
    expect(now).toMatchObject({ segmentId: null, segmentName: null, sendAt: NOW });

    const page = await broadcasts.list(a, { first: 1 });
    expect(page.items.map((each) => each.name)).toEqual(['Flash sale']);
    expect(page.hasNextPage).toBe(true);
    const next = await broadcasts.list(a, { first: 1, after: page.items[0]!.id });
    expect(next.items.map((each) => each.name)).toEqual(['Eid sale']);
    expect((await broadcasts.list(b, { first: 10 })).items).toEqual([]);

    const audit = await admin.query<{ action: string; subject_type: string }>(
      "SELECT action, subject_type FROM platform.audit_log WHERE action LIKE 'broadcast.%' ORDER BY id",
    );
    expect(audit.rows).toEqual([
      { action: 'broadcast.scheduled', subject_type: 'broadcast' },
      { action: 'broadcast.scheduled', subject_type: 'broadcast' },
    ]);
  });

  it('counts how its messages went, and cancels what is not yet sent', async () => {
    const sale = unwrap(await broadcasts.create(a, { name: 'Counted', templateId: approved }, NOW));
    const statuses = ['pending', 'pending', 'sent', 'delivered', 'read', 'failed', 'skipped'];
    for (const [index, status] of statuses.entries()) {
      await admin.query(
        `INSERT INTO messaging.messages
                (shop_id, kind, channel, recipient, language, dedupe_key, status, broadcast_id)
         VALUES ($1, 'order_placed', 'whatsapp', $2, 'en', $3, $4, $5)`,
        [a.shopId, `+92300222000${index}`, `broadcast:${sale.id}:${index}`, status, sale.id],
      );
    }
    expect((await broadcasts.get(a, sale.id))!.counts).toEqual({
      pending: 2,
      sent: 3,
      delivered: 2,
      read: 1,
      failed: 1,
      skipped: 1,
    });
    expect(await broadcasts.get(b, sale.id)).toBeNull();

    const cancelled = unwrap(await broadcasts.cancel(a, sale.id));
    expect(cancelled).toMatchObject({
      status: 'cancelled',
      finishedAt: expect.any(Date),
      counts: { pending: 0, skipped: 3, sent: 3 },
    });
    const again = await broadcasts.cancel(a, sale.id);
    expect(again.ok || again.errors[0]!.message).toBe('The broadcast is cancelled already');
    const other = await broadcasts.cancel(b, sale.id);
    expect(other.ok || other.errors[0]!.code).toBe('NOT_FOUND');
    const { rows } = await admin.query<{ event_type: string }>(
      "SELECT event_type FROM platform.outbox_events WHERE event_type LIKE 'broadcast.%' ORDER BY id",
    );
    expect(rows.map((row) => row.event_type).slice(-2)).toEqual([
      'broadcast.scheduled',
      'broadcast.cancelled',
    ]);
  });
});
