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
import { MetaConversionsService } from './meta-settings.service.js';
import { tiktokSettings } from './schema.js';
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

const TOKEN = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8Wx9z';
const PIXEL = 'CABC123DEF456GHI789J';

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

describe.skipIf(!server)("TikTok's Events API: the shop's pixel and its moments", () => {
  let testDb: TestDatabase;
  let db: Database;
  let admin: pg.Client;
  let tiktok: TikTokEventsService;
  let moments: ConversionsService;
  const box = new SecretBox([{ id: 'k1', key: randomBytes(32) }]);
  const a = tenant(newId());
  const b = tenant(newId());

  const outbox = async () =>
    (
      await admin.query<{ event_type: string; payload: Record<string, unknown> }>(
        'SELECT event_type, payload FROM platform.outbox_events ORDER BY id',
      )
    ).rows.map((row) => [row.event_type, row.payload.changed ?? row.payload.pixelCode]);

  beforeAll(async () => {
    testDb = await createTestDatabase(server!);
    db = new Database({
      appUrl: testDb.appUrl,
      systemUrl: testDb.systemUrl,
      applicationName: 'tiktok-test',
    });
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'A'), ($2, 'B')`, [
      a.shopId,
      b.shopId,
    ]);
    tiktok = new TikTokEventsService(db, box);
    moments = new ConversionsService(db);
  });

  afterAll(async () => {
    await db?.close();
    await admin?.end();
    await testDb?.drop();
  });

  beforeEach(async () => {
    await admin.query(
      'DELETE FROM marketing.tiktok_settings; DELETE FROM marketing.meta_settings; ' +
        'DELETE FROM marketing.conversions; DELETE FROM platform.outbox_events; ' +
        'DELETE FROM platform.audit_log',
    );
  });

  it('matches the migrated table', async () => {
    await db.tenant(a.shopId, (tx) => tx.select().from(tiktokSettings).limit(1));
  });

  it('connects with the pixel and a token, keeping the token sealed and showing its end', async () => {
    expect(await tiktok.get(a)).toBeNull();
    const noPixel = await tiktok.update(a, { accessToken: TOKEN });
    expect(noPixel.ok || noPixel.errors.map((e) => [e.field.join('.'), e.code])).toEqual([
      ['input.pixelCode', 'BLANK'],
    ]);
    const noToken = await tiktok.update(a, { pixelCode: PIXEL });
    expect(noToken.ok || noToken.errors.map((e) => [e.field.join('.'), e.code])).toEqual([
      ['input.accessToken', 'BLANK'],
    ]);
    const wrong = await tiktok.update(a, {
      pixelCode: 'pixel-1',
      accessToken: 'short token',
      testEventCode: 'TEST 1',
    });
    expect(wrong.ok || wrong.errors.map((e) => [e.field.join('.'), e.code])).toEqual([
      ['input.pixelCode', 'INVALID'],
      ['input.accessToken', 'INVALID'],
      ['input.testEventCode', 'INVALID'],
    ]);

    // Its code as Events Manager shows it, in capitals, spaces taken out.
    const connected = unwrap(
      await tiktok.update(a, { pixelCode: ' cabc123def 456ghi789j ', accessToken: ` ${TOKEN} ` }),
    );
    expect(connected).toMatchObject({
      pixelCode: PIXEL,
      tokenHint: 'Wx9z',
      testEventCode: null,
      purchaseAt: 'placed',
    });
    const { rows } = await admin.query<{ access_token: string }>(
      'SELECT access_token FROM marketing.tiktok_settings',
    );
    expect(rows[0]!.access_token).not.toContain(TOKEN);
    expect(await tiktok.pixelOf(a.shopId)).toEqual({
      pixelCode: PIXEL,
      accessToken: TOKEN,
      testEventCode: null,
      purchaseAt: 'placed',
    });
    // The other shop sees none of it.
    expect(await tiktok.get(b)).toBeNull();
    expect(await tiktok.pixelOf(b.shopId)).toBeNull();

    // Only what changed is told; the same again changes nothing.
    unwrap(await tiktok.update(a, { testEventCode: 'TEST31337', purchaseAt: 'delivered' }));
    unwrap(await tiktok.update(a, { accessToken: TOKEN, testEventCode: 'TEST31337' }));
    unwrap(await tiktok.update(a, { testEventCode: '' }));
    expect(await outbox()).toEqual([
      ['tiktok_events.updated', ['pixelCode', 'accessToken']],
      ['tiktok_events.updated', ['testEventCode', 'purchaseAt']],
      ['tiktok_events.updated', ['testEventCode']],
    ]);
    const audit = await admin.query<{ action: string; details: Record<string, unknown> }>(
      'SELECT action, details FROM platform.audit_log ORDER BY id',
    );
    expect(audit.rows.map((row) => row.action)).toEqual([
      'tiktok_events.updated',
      'tiktok_events.updated',
      'tiktok_events.updated',
    ]);
    // The token is never written down.
    expect(JSON.stringify(audit.rows)).not.toContain(TOKEN);
    expect(await tiktok.get(a)).toMatchObject({ testEventCode: null, purchaseAt: 'delivered' });
  });

  it('connects nothing on a plan without the conversions API', async () => {
    const starter = new TikTokEventsService(db, box, new Starter());
    const refused = await starter.update(a, { pixelCode: PIXEL, accessToken: TOKEN });
    expect(refused.ok || refused.errors.map((e) => [e.field.join('.'), e.code])).toEqual([
      ['input', 'INVALID'],
    ]);
    expect(await tiktok.get(a)).toBeNull();
  });

  it("records an order's placing for TikTok beside Meta's, and skips TikTok's waiting when it disconnects", async () => {
    const meta = new MetaConversionsService(db, box);
    const at = new Date();
    const first = newId();
    expect(await moments.recordPlaced(a.shopId, first, at)).toBe(0);

    unwrap(await tiktok.update(a, { pixelCode: PIXEL, accessToken: TOKEN }));
    const second = newId();
    expect(await moments.recordPlaced(a.shopId, second, at)).toBe(1);
    unwrap(await meta.update(a, { pixelId: '1234567890', accessToken: 'EAAG'.padEnd(60, 'q') }));
    const third = newId();
    expect(await moments.recordPlaced(a.shopId, third, at)).toBe(2);
    expect(await moments.recordPlaced(a.shopId, third, at)).toBe(0);
    // Its later moments go where its placing went.
    expect(await moments.recordAfterPlaced(a.shopId, second, 'confirmed', at)).toBe(1);
    expect(await moments.recordAfterPlaced(a.shopId, third, 'confirmed', at)).toBe(2);

    expect(await tiktok.delete(a)).toBe(PIXEL);
    expect(await tiktok.delete(a)).toBeNull();
    const { rows } = await admin.query<{ order_id: string; platform: string; status: string }>(
      `SELECT order_id, platform, moment, status FROM marketing.conversions
        ORDER BY order_id, platform, moment`,
    );
    // Meta's still go.
    expect(rows.map((row) => [row.order_id, row.platform, row.status])).toEqual([
      [second, 'tiktok', 'skipped'],
      [second, 'tiktok', 'skipped'],
      [third, 'meta', 'pending'],
      [third, 'meta', 'pending'],
      [third, 'tiktok', 'skipped'],
      [third, 'tiktok', 'skipped'],
    ]);
    expect((await outbox()).at(-1)).toEqual(['tiktok_events.deleted', PIXEL]);
    expect(await tiktok.get(a)).toBeNull();
  });
});
