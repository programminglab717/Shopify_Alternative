import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { PlanAllowance, type MutationResult, type TenantContext } from '@hatti/api';
import { SecretBox } from '@hatti/crypto';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConversionsService } from './conversions.service.js';
import { GoogleAnalyticsService } from './google-settings.service.js';
import { googleSettings } from './schema.js';
import { TikTokEventsService } from './tiktok-settings.service.js';

/** Starter: no conversions API (ADR-523, ADR-531). */
class Starter extends PlanAllowance {
  async limitOf(): Promise<null> {
    return null;
  }

  async limitIn(): Promise<null> {
    return null;
  }

  async excludes(_shopId: string, feature: string): Promise<string | null> {
    return feature === 'conversionsApi' ? 'Starter' : null;
  }
}

const server = testDatabaseServer();

const SECRET = 'Xy9_kq2LmN0pQrStUvWz';
const STREAM = 'G-AB12CD34EF';

function unwrap<T>(result: MutationResult<T>): T {
  if (!result.ok) throw new Error(`Expected success, got ${JSON.stringify(result.errors)}`);
  return result.value;
}

function tenant(shopId: string): TenantContext {
  return {
    shopId,
    currency: 'PKR',
    actor: { kind: 'app', tokenId: newId() },
    scopes: new Set(['write_pixels']),
  };
}

describe.skipIf(!server)("Google Analytics for ads: the shop's stream and its moments", () => {
  let testDb: TestDatabase;
  let db: Database;
  let admin: pg.Client;
  let google: GoogleAnalyticsService;
  let moments: ConversionsService;
  const box = new SecretBox([{ id: 'k1', key: randomBytes(32) }]);
  const a = tenant(newId());
  const b = tenant(newId());

  const outbox = async () =>
    (
      await admin.query<{ event_type: string; payload: Record<string, unknown> }>(
        'SELECT event_type, payload FROM platform.outbox_events ORDER BY id',
      )
    ).rows.map((row) => [row.event_type, row.payload.changed ?? row.payload.measurementId]);

  beforeAll(async () => {
    testDb = await createTestDatabase(server!);
    db = new Database({
      appUrl: testDb.appUrl,
      systemUrl: testDb.systemUrl,
      applicationName: 'google-test',
    });
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'A'), ($2, 'B')`, [
      a.shopId,
      b.shopId,
    ]);
    google = new GoogleAnalyticsService(db, box);
    moments = new ConversionsService(db);
  });

  afterAll(async () => {
    await db?.close();
    await admin?.end();
    await testDb?.drop();
  });

  beforeEach(async () => {
    await admin.query(
      'DELETE FROM marketing.google_settings; DELETE FROM marketing.tiktok_settings; ' +
        'DELETE FROM marketing.conversions; DELETE FROM platform.outbox_events; ' +
        'DELETE FROM platform.audit_log',
    );
  });

  it('matches the migrated table', async () => {
    await db.tenant(a.shopId, (tx) => tx.select().from(googleSettings).limit(1));
  });

  it('connects with the measurement ID and a secret, keeping the secret sealed and showing its end', async () => {
    expect(await google.get(a)).toBeNull();
    const noStream = await google.update(a, { apiSecret: SECRET });
    expect(noStream.ok || noStream.errors.map((e) => [e.field.join('.'), e.code])).toEqual([
      ['input.measurementId', 'BLANK'],
    ]);
    const noSecret = await google.update(a, { measurementId: STREAM });
    expect(noSecret.ok || noSecret.errors.map((e) => [e.field.join('.'), e.code])).toEqual([
      ['input.apiSecret', 'BLANK'],
    ]);
    const wrong = await google.update(a, { measurementId: 'UA-12345-1', apiSecret: 'a secret' });
    expect(wrong.ok || wrong.errors.map((e) => [e.field.join('.'), e.code])).toEqual([
      ['input.measurementId', 'INVALID'],
      ['input.apiSecret', 'INVALID'],
    ]);

    // Its ID as Google Analytics shows it, in capitals, spaces taken out.
    const connected = unwrap(
      await google.update(a, { measurementId: ' g-ab12 cd34ef ', apiSecret: ` ${SECRET} ` }),
    );
    expect(connected).toMatchObject({
      measurementId: STREAM,
      secretHint: 'UvWz',
      purchaseAt: 'placed',
    });
    const { rows } = await admin.query<{ api_secret: string }>(
      'SELECT api_secret FROM marketing.google_settings',
    );
    expect(rows[0]!.api_secret).not.toContain(SECRET);
    expect(await google.streamOf(a.shopId)).toEqual({
      measurementId: STREAM,
      apiSecret: SECRET,
      purchaseAt: 'placed',
    });
    // The other shop sees none of it.
    expect(await google.get(b)).toBeNull();
    expect(await google.streamOf(b.shopId)).toBeNull();

    // Only what changed is told; the same again changes nothing.
    unwrap(await google.update(a, { purchaseAt: 'delivered' }));
    unwrap(await google.update(a, { apiSecret: SECRET, purchaseAt: 'delivered' }));
    unwrap(await google.update(a, { measurementId: 'G-ZZ99YY88' }));
    expect(await outbox()).toEqual([
      ['google_analytics.updated', ['measurementId', 'apiSecret']],
      ['google_analytics.updated', ['purchaseAt']],
      ['google_analytics.updated', ['measurementId']],
    ]);
    const audit = await admin.query<{ action: string }>(
      'SELECT action, details FROM platform.audit_log ORDER BY id',
    );
    expect(audit.rows.map((row) => row.action)).toEqual([
      'google_analytics.updated',
      'google_analytics.updated',
      'google_analytics.updated',
    ]);
    // The secret is never written down.
    expect(JSON.stringify(audit.rows)).not.toContain(SECRET);
    expect(await google.get(a)).toMatchObject({
      measurementId: 'G-ZZ99YY88',
      purchaseAt: 'delivered',
    });
  });

  it('connects nothing on a plan without the conversions API', async () => {
    const starter = new GoogleAnalyticsService(db, box, new Starter());
    const refused = await starter.update(a, { measurementId: STREAM, apiSecret: SECRET });
    expect(refused.ok || refused.errors.map((e) => [e.field.join('.'), e.code])).toEqual([
      ['input', 'INVALID'],
    ]);
    expect(await google.get(a)).toBeNull();
  });

  it("records an order's placing for Google beside TikTok's, and skips Google's waiting when it disconnects", async () => {
    const tiktok = new TikTokEventsService(db, box);
    const at = new Date();
    unwrap(await google.update(a, { measurementId: STREAM, apiSecret: SECRET }));
    const first = newId();
    expect(await moments.recordPlaced(a.shopId, first, at)).toBe(1);
    unwrap(
      await tiktok.update(a, {
        pixelCode: 'CABC123DEF456GHI789J',
        accessToken: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8Wx9z',
      }),
    );
    const second = newId();
    expect(await moments.recordPlaced(a.shopId, second, at)).toBe(2);
    expect(await moments.recordAfterPlaced(a.shopId, second, 'confirmed', at)).toBe(2);

    expect(await google.delete(a)).toBe(STREAM);
    expect(await google.delete(a)).toBeNull();
    const { rows } = await admin.query<{ order_id: string; platform: string; status: string }>(
      `SELECT order_id, platform, moment, status FROM marketing.conversions
        ORDER BY order_id, platform, moment`,
    );
    // TikTok's still go.
    expect(rows.map((row) => [row.order_id, row.platform, row.status])).toEqual([
      [first, 'google', 'skipped'],
      [second, 'google', 'skipped'],
      [second, 'google', 'skipped'],
      [second, 'tiktok', 'pending'],
      [second, 'tiktok', 'pending'],
    ]);
    expect((await outbox()).at(-1)).toEqual(['google_analytics.deleted', STREAM]);
  });
});
