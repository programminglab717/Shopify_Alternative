import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import type { MutationResult, TenantContext } from '@hatti/api';
import { SecretBox } from '@hatti/crypto';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeGraph, NUMBER, TOKEN, WABA } from './test-support.js';
import { WhatsAppAccountsService } from './whatsapp-accounts.service.js';
import { qualityOf, type WhatsAppSignupSettings } from './whatsapp-business.js';

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
    scopes: new Set(['write_settings']),
  };
}

/** Meta's Graph API as connecting a number asks it, each request kept. */
describe.skipIf(!server)("A shop's own WhatsApp number (MKT-01, ADR-419)", () => {
  let testDb: TestDatabase;
  let db: Database;
  let admin: pg.Client;
  let graph: FakeGraph;
  let accounts: WhatsAppAccountsService;
  let signup: WhatsAppSignupSettings;
  const box = new SecretBox([{ id: 'k1', key: randomBytes(32) }]);
  const a = tenant(newId());
  const b = tenant(newId());
  const connecting = { code: 'good-code', businessAccountId: WABA, phoneNumberId: NUMBER };

  beforeAll(async () => {
    testDb = await createTestDatabase(server!);
    db = new Database({
      appUrl: testDb.appUrl,
      systemUrl: testDb.systemUrl,
      applicationName: 'whatsapp-accounts-test',
    });
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'A'), ($2, 'B')`, [
      a.shopId,
      b.shopId,
    ]);
    graph = new FakeGraph();
    signup = {
      appId: '1234567890',
      appSecret: 'app-secret',
      configurationId: '987654321',
      baseUrl: await graph.start(),
      version: 'v26.0',
    };
    accounts = new WhatsAppAccountsService(db, box, signup);
  });

  afterAll(async () => {
    await graph?.stop();
    await db?.close();
    await admin?.end();
    await testDb?.drop();
  });

  beforeEach(async () => {
    graph.requests.length = 0;
    graph.registerError = null;
    await admin.query(
      'DELETE FROM messaging.whatsapp_accounts; DELETE FROM platform.outbox_events; ' +
        'DELETE FROM platform.audit_log',
    );
  });

  it('connects the number Embedded Signup shared, its token and PIN kept sealed', async () => {
    expect(accounts.signup()).toEqual({
      appId: '1234567890',
      configurationId: '987654321',
      graphVersion: 'v26.0',
    });
    expect(await accounts.get(a)).toBeNull();

    const account = unwrap(await accounts.connect(a, connecting));
    expect(account).toMatchObject({
      businessAccountId: WABA,
      phoneNumberId: NUMBER,
      displayPhoneNumber: '+92 300 1234567',
      verifiedName: 'Zari Fashions',
      qualityRating: 'green',
    });
    expect(await accounts.get(a)).toEqual(account);
    expect(await accounts.get(b)).toBeNull();

    // The code exchanged, the number found in the account, the app subscribed, the number
    // registered with a PIN of six digits: each with the business token, out of the address.
    expect(graph.requests.map((each) => `${each.method} ${each.path}`)).toEqual([
      'GET oauth/access_token',
      `GET ${WABA}/phone_numbers`,
      `POST ${WABA}/subscribed_apps`,
      `POST ${NUMBER}/register`,
    ]);
    const register = graph.requests[3]!;
    expect(register.body).toEqual({ messaging_product: 'whatsapp', pin: expect.any(String) });
    const pin = (register.body as { pin: string }).pin;
    expect(pin).toMatch(/^[0-9]{6}$/);

    const { rows } = await admin.query<{ access_token: string; pin: string }>(
      'SELECT access_token, pin FROM messaging.whatsapp_accounts WHERE shop_id = $1',
      [a.shopId],
    );
    expect(rows[0]!.access_token).not.toContain(TOKEN.slice(0, 16));
    expect(rows[0]!.pin).not.toBe(pin);
    // The worker opens it to send, for that shop alone.
    expect(await accounts.senderOf(a.shopId)).toEqual({
      businessAccountId: WABA,
      phoneNumberId: NUMBER,
      accessToken: TOKEN,
    });
    expect(await accounts.senderOf(b.shopId)).toBeNull();

    const audit = await admin.query<{ action: string; details: Record<string, unknown> }>(
      'SELECT action, details FROM platform.audit_log',
    );
    expect(audit.rows).toEqual([
      {
        action: 'whatsapp_account.connected',
        details: {
          businessAccountId: WABA,
          phoneNumberId: NUMBER,
          displayPhoneNumber: '+92 300 1234567',
          verifiedName: 'Zari Fashions',
          before: null,
        },
      },
    ]);
    expect(JSON.stringify(audit.rows)).not.toContain(TOKEN.slice(0, 16));
  });

  it("refuses what Meta refuses, a number not in the account, and another shop's number", async () => {
    const used = await accounts.connect(a, { ...connecting, code: 'used-code' });
    expect(used).toEqual({
      ok: false,
      errors: [
        {
          field: ['input', 'code'],
          code: 'INVALID',
          message: 'Meta 100: This authorization code has been used.',
        },
      ],
    });
    const other = await accounts.connect(a, { ...connecting, phoneNumberId: '1065403522' });
    expect(other.ok || other.errors[0]).toMatchObject({
      field: ['input', 'phoneNumberId'],
      code: 'NOT_FOUND',
    });
    graph.registerError = 'Two step verification PIN Mismatch';
    const unregistered = await accounts.connect(a, connecting);
    expect(unregistered.ok || unregistered.errors[0]).toEqual({
      field: ['input', 'phoneNumberId'],
      code: 'INVALID',
      message: 'Meta 133005: Two step verification PIN Mismatch',
    });
    expect(await accounts.get(a)).toBeNull();

    // Meta's IDs are digits: nothing else is sent.
    graph.requests.length = 0;
    const bad = await accounts.connect(a, {
      code: ' ',
      businessAccountId: 'x',
      phoneNumberId: NUMBER,
    });
    expect(bad.ok || bad.errors.map((error) => [error.field.at(-1), error.code])).toEqual([
      ['code', 'BLANK'],
      ['businessAccountId', 'INVALID'],
    ]);
    expect(graph.requests).toEqual([]);

    // A number sends for one shop at a time.
    graph.registerError = null;
    unwrap(await accounts.connect(a, connecting));
    const taken = await accounts.connect(b, connecting);
    expect(taken.ok || taken.errors[0]).toEqual({
      field: ['input', 'phoneNumberId'],
      code: 'TAKEN',
      message: 'This number is connected to another shop on Hatti',
    });
    expect(await accounts.get(b)).toBeNull();
  });

  it('disconnects, forgetting the token and unsubscribing the app', async () => {
    unwrap(await accounts.connect(a, connecting));
    graph.requests.length = 0;
    expect(await accounts.disconnect(a)).toBe('+92 300 1234567');
    expect(graph.requests.map((each) => `${each.method} ${each.path}`)).toEqual([
      `DELETE ${WABA}/subscribed_apps`,
    ]);
    expect(await accounts.get(a)).toBeNull();
    expect(await accounts.senderOf(a.shopId)).toBeNull();
    expect(await accounts.disconnect(a)).toBeNull();
    const { rows } = await admin.query<{ event_type: string }>(
      'SELECT event_type FROM platform.outbox_events ORDER BY id',
    );
    expect(rows.map((row) => row.event_type)).toEqual([
      'whatsapp_account.connected',
      'whatsapp_account.disconnected',
    ]);
    // Free again for another shop.
    unwrap(await accounts.connect(b, connecting));
  });

  it('says connecting is not set up on a server without Embedded Signup', async () => {
    const without = new WhatsAppAccountsService(db, box, null);
    expect(without.signup()).toBeNull();
    const result = await without.connect(a, connecting);
    expect(result.ok || result.errors[0]!.code).toBe('UNAVAILABLE');
  });

  it("reads Meta's quality ratings", () => {
    expect(['GREEN', 'YELLOW', 'RED', 'NA', null].map(qualityOf)).toEqual([
      'green',
      'yellow',
      'red',
      'unknown',
      'unknown',
    ]);
  });
});
