import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import type { MutationResult, TenantContext } from '@hatti/api';
import { SecretBox } from '@hatti/crypto';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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

const EID = {
  name: 'eid_sale',
  language: 'en' as const,
  header: 'Eid sale',
  body: 'Assalam-o-Alaikum {{1}}! Our Eid lawn is 20% off until Sunday.',
  footer: 'Reply STOP to hear no more',
  buttonText: 'Shop now',
  buttonUrl: 'https://zari.hatti.pk/collections/eid',
};

describe.skipIf(!server)("A shop's own WhatsApp templates (MKT-01, ADR-420)", () => {
  let testDb: TestDatabase;
  let db: Database;
  let admin: pg.Client;
  let graph: FakeGraph;
  let accounts: WhatsAppAccountsService;
  let templates: WhatsAppTemplatesService;
  const box = new SecretBox([{ id: 'k1', key: randomBytes(32) }]);
  const a = tenant(newId());
  const b = tenant(newId());

  const events = async () =>
    (
      await admin.query<{ event_type: string; payload: Record<string, unknown> }>(
        "SELECT event_type, payload FROM platform.outbox_events WHERE event_type LIKE 'whatsapp_template.%' ORDER BY id",
      )
    ).rows.map((row) => [row.event_type, row.payload.status ?? row.payload.name]);

  beforeAll(async () => {
    testDb = await createTestDatabase(server!);
    db = new Database({
      appUrl: testDb.appUrl,
      systemUrl: testDb.systemUrl,
      applicationName: 'whatsapp-templates-test',
    });
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'A'), ($2, 'B')`, [
      a.shopId,
      b.shopId,
    ]);
    graph = new FakeGraph();
    accounts = new WhatsAppAccountsService(db, box, {
      appId: '1234567890',
      appSecret: 'app-secret',
      configurationId: '987654321',
      baseUrl: await graph.start(),
      version: 'v26.0',
    });
    templates = new WhatsAppTemplatesService(db, accounts);
  });

  afterAll(async () => {
    await graph?.stop();
    await db?.close();
    await admin?.end();
    await testDb?.drop();
  });

  beforeEach(async () => {
    graph.requests.length = 0;
    graph.templates.length = 0;
    graph.templateError = null;
    await admin.query(
      'DELETE FROM messaging.whatsapp_templates; DELETE FROM messaging.whatsapp_accounts; ' +
        'DELETE FROM platform.outbox_events; DELETE FROM platform.audit_log',
    );
  });

  const connect = () =>
    accounts.connect(a, { code: 'good-code', businessAccountId: WABA, phoneNumberId: NUMBER });

  it('sends a template to Meta for approval, and keeps it once Meta has it', async () => {
    // A shop without its own number has nowhere to send one.
    expect(await templates.list(a)).toEqual([]);
    const early = await templates.create(a, EID);
    expect(early.ok || early.errors[0]).toEqual({
      field: ['input'],
      code: 'INVALID',
      message: "Connect the shop's own WhatsApp number first",
    });

    unwrap(await connect());
    graph.requests.length = 0;
    const template = unwrap(await templates.create(a, EID));
    expect(template).toMatchObject({ ...EID, status: 'pending', rejectedReason: null });
    expect(graph.requests).toEqual([
      {
        method: 'POST',
        path: `${WABA}/message_templates`,
        auth: expect.stringMatching(/^Bearer EAAQ/),
        body: {
          name: 'eid_sale',
          language: 'en',
          category: 'MARKETING',
          components: [
            { type: 'HEADER', format: 'TEXT', text: 'Eid sale' },
            {
              type: 'BODY',
              text: EID.body,
              example: { body_text: [['Ayesha']] },
            },
            { type: 'FOOTER', text: 'Reply STOP to hear no more' },
            {
              type: 'BUTTONS',
              buttons: [{ type: 'URL', text: 'Shop now', url: EID.buttonUrl }],
            },
          ],
        },
      },
    ]);
    expect(await templates.list(a)).toEqual([template]);
    expect(await templates.list(b)).toEqual([]);

    // The same name in another language is another template; in the same, it is taken.
    const taken = await templates.create(a, EID);
    expect(taken.ok || taken.errors[0]!.code).toBe('TAKEN');
    const urdu = unwrap(
      await templates.create(a, { name: 'eid_sale', language: 'ur', body: 'عید مبارک {{1}}!' }),
    );
    expect(urdu).toMatchObject({ header: null, footer: null, buttonText: null, buttonUrl: null });
    expect(graph.requests.at(-1)!.body).toEqual({
      name: 'eid_sale',
      language: 'ur',
      category: 'MARKETING',
      components: [
        { type: 'BODY', text: 'عید مبارک {{1}}!', example: { body_text: [['Ayesha']] } },
      ],
    });
    expect((await templates.list(a)).map((each) => each.language)).toEqual(['ur', 'en']);
    expect(await events()).toEqual([
      ['whatsapp_template.created', 'eid_sale'],
      ['whatsapp_template.created', 'eid_sale'],
    ]);
    const audit = await admin.query<{ action: string; subject_type: string }>(
      'SELECT action, subject_type FROM platform.audit_log ORDER BY id',
    );
    expect(audit.rows.filter((row) => row.action.startsWith('whatsapp_template.'))).toEqual([
      { action: 'whatsapp_template.created', subject_type: 'whatsAppTemplate' },
      { action: 'whatsapp_template.created', subject_type: 'whatsAppTemplate' },
    ]);
  });

  it("refuses what Meta would, and what Meta refuses, in Meta's words", async () => {
    unwrap(await connect());
    graph.requests.length = 0;
    const bad = await templates.create(a, {
      name: 'Eid Sale!',
      language: 'en',
      header: 'Hi {{1}}',
      body: 'Dear {{1}}, your {{2}} is ready',
      buttonText: 'Shop now',
      buttonUrl: 'http://zari.hatti.pk',
    });
    expect(bad.ok || bad.errors.map((error) => [error.field.at(-1), error.code])).toEqual([
      ['name', 'INVALID'],
      ['header', 'INVALID'],
      ['body', 'INVALID'],
      ['buttonUrl', 'INVALID'],
    ]);
    const half = await templates.create(a, {
      name: 'x',
      language: 'en',
      body: 'Hi',
      buttonText: 'Go',
    });
    expect(half.ok || half.errors.map((error) => error.message)).toEqual([
      "Button url can't be blank when the button has a link",
    ]);
    expect(graph.requests).toEqual([]);

    graph.templateError = 'Your template has too many variables for its length.';
    const refused = await templates.create(a, EID);
    expect(refused.ok || refused.errors[0]).toEqual({
      field: ['input'],
      code: 'INVALID',
      message: 'Meta 100: Your template has too many variables for its length.',
    });
    expect(await templates.list(a)).toEqual([]);
  });

  it("keeps what Meta's webhook says, and what Meta says when asked again", async () => {
    unwrap(await connect());
    const template = unwrap(await templates.create(a, EID));
    const [meta] = graph.templates;

    await templates.recordStatuses([
      { metaTemplateId: meta!.id, event: 'APPROVED', reason: null },
      { metaTemplateId: '1', event: 'APPROVED', reason: null },
    ]);
    expect((await templates.get(a.shopId, template.id))!.status).toBe('approved');
    // Heard twice, it is one change; one Meta has not named, none.
    await templates.recordStatuses([
      { metaTemplateId: meta!.id, event: 'APPROVED', reason: null },
      { metaTemplateId: meta!.id, event: 'FLAGGED', reason: 'LOW_QUALITY' },
    ]);
    await templates.recordStatuses([
      { metaTemplateId: meta!.id, event: 'REJECTED', reason: 'INVALID_FORMAT' },
    ]);
    expect(await templates.get(a.shopId, template.id)).toMatchObject({
      status: 'rejected',
      rejectedReason: 'INVALID_FORMAT',
    });

    // Asked again, Meta says it is paused now.
    meta!.status = 'PAUSED';
    meta!.rejected_reason = 'NONE';
    const synced = unwrap(await templates.sync(a));
    expect(synced.map((each) => [each.status, each.rejectedReason])).toEqual([['paused', null]]);
    expect(await events()).toEqual([
      ['whatsapp_template.created', 'eid_sale'],
      ['whatsapp_template.status_changed', 'approved'],
      ['whatsapp_template.status_changed', 'rejected'],
      ['whatsapp_template.status_changed', 'paused'],
    ]);
  });

  it('deletes a template from Meta too, and none of another shop', async () => {
    unwrap(await connect());
    const template = unwrap(await templates.create(a, EID));
    const other = await templates.delete(b, template.id);
    expect(other.ok || other.errors[0]!.code).toBe('NOT_FOUND');
    expect(unwrap(await templates.delete(a, template.id))).toBe(template.id);
    expect(graph.requests.at(-1)).toMatchObject({
      method: 'DELETE',
      path: `${WABA}/message_templates`,
    });
    expect(graph.templates).toEqual([]);
    expect(await templates.list(a)).toEqual([]);

    // Deleted in Meta's own pages already, it goes here too.
    const again = unwrap(await templates.create(a, EID));
    graph.templates.length = 0;
    expect(unwrap(await templates.delete(a, again.id))).toBe(again.id);

    // With the number disconnected, the shop's templates go from Hatti alone.
    const kept = unwrap(await templates.create(a, EID));
    await accounts.disconnect(a);
    expect(await templates.list(a)).toEqual([]);
    graph.requests.length = 0;
    expect(unwrap(await templates.delete(a, kept.id))).toBe(kept.id);
    expect(graph.requests).toEqual([]);
  });
});
