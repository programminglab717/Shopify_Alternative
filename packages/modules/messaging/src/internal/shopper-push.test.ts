import 'reflect-metadata';
import type { TenantContext } from '@hatti/api';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  SHOPPER_PUSH_LIMITS,
  ShopperPushService,
  isPushServiceEndpoint,
} from './shopper-push.service.js';
import { generateVapidKeys, type PushOutcome, type WebPushSender } from './web-push.js';

const server = testDatabaseServer();

/** A push service's sender, each push kept, answering as each endpoint is told to. */
class FakeSender {
  readonly publicKey = generateVapidKeys().publicKey;
  readonly sent: { endpoint: string; message: Record<string, string> }[] = [];
  readonly answers = new Map<string, PushOutcome>();

  send(subscription: { endpoint: string }, message: object): Promise<PushOutcome> {
    this.sent.push({ endpoint: subscription.endpoint, message: message as Record<string, string> });
    return Promise.resolve(this.answers.get(subscription.endpoint) ?? 'sent');
  }
}

const P256DH = 'B'.repeat(87);
const AUTH = 'a'.repeat(22);
const endpoint = (name: string) => `https://fcm.googleapis.com/fcm/send/${name}`;
/** 3 pm in Karachi, in marketing hours; and 11 pm, out of them. */
const AFTERNOON = new Date('2026-10-27T10:00:00Z');
const NIGHT = new Date('2026-10-27T18:00:00Z');

function staff(shopId: string): TenantContext {
  return {
    shopId,
    currency: 'PKR',
    actor: {
      kind: 'staff',
      userId: newId(),
      sessionId: newId(),
      authenticatedAt: new Date(),
      role: 'owner',
    },
    scopes: new Set(),
  };
}

describe('The push services shoppers subscribe with (ADR-833)', () => {
  it("takes browsers' push services alone, never another address", () => {
    for (const ok of [
      'https://fcm.googleapis.com/fcm/send/abc:def',
      'https://updates.push.services.mozilla.com/wpush/v2/gAAAA',
      'https://web.push.apple.com/QGuQ',
      'https://wns2-par02p.notify.windows.com/w/?token=x',
    ]) {
      expect([ok, isPushServiceEndpoint(ok)]).toEqual([ok, true]);
    }
    for (const bad of [
      'http://fcm.googleapis.com/fcm/send/abc',
      'https://fcm.googleapis.com:8443/fcm/send/abc',
      'https://user:pw@fcm.googleapis.com/fcm/send/abc',
      'https://fcm.googleapis.com.evil.example/x',
      'https://169.254.169.254/latest/meta-data',
      'https://localhost/x',
      'not a url',
      `https://fcm.googleapis.com/${'x'.repeat(1000)}`,
    ]) {
      expect([bad, isPushServiceEndpoint(bad)]).toEqual([bad, false]);
    }
  });
});

describe.skipIf(!server)("Pushes to shoppers' browsers (OS-14, ADR-833, ADR-834)", () => {
  let testDb: TestDatabase;
  let db: Database;
  let admin: pg.Client;
  let sender: FakeSender;
  let pushes: ShopperPushService;
  const shopId = newId();
  const other = newId();
  const tenant = staff(shopId);

  beforeAll(async () => {
    testDb = await createTestDatabase(server!);
    db = new Database({
      appUrl: testDb.appUrl,
      systemUrl: testDb.systemUrl,
      applicationName: 'shopper-push-test',
    });
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(
      `INSERT INTO control.shops (id, name, timezone) VALUES ($1, 'Zari', 'Asia/Karachi'),
                                                         ($2, 'Other', 'Asia/Karachi')`,
      [shopId, other],
    );
  });

  beforeEach(async () => {
    await admin.query('DELETE FROM messaging.shopper_push_subscriptions');
    await admin.query('DELETE FROM messaging.push_campaigns');
    sender = new FakeSender();
    pushes = new ShopperPushService(db, sender as unknown as WebPushSender);
  });

  afterAll(async () => {
    await admin?.end();
    await db?.close();
    await testDb?.drop();
  });

  const subscribe = (name: string, shop = shopId) =>
    pushes.subscribe(shop, { endpoint: endpoint(name), p256dh: P256DH, auth: AUTH, locale: 'ur' });

  it("keeps a browser's subscription once, refuses one that is none, and forgets it", async () => {
    expect(await subscribe('a')).toEqual({ ok: true, value: null });
    expect(await subscribe('a')).toEqual({ ok: true, value: null });
    expect(await subscribe('b', other)).toEqual({ ok: true, value: null });
    expect(await pushes.subscriberCount(tenant)).toBe(1);
    const refused = await pushes.subscribe(shopId, {
      endpoint: 'https://169.254.169.254/latest',
      p256dh: 'short',
      auth: AUTH,
    });
    expect(refused?.ok === false && refused.errors.map((error) => error.field.join('.'))).toEqual([
      'endpoint',
      'keys',
    ]);
    expect(await pushes.unsubscribe(shopId, endpoint('b'))).toBe(false);
    expect(await pushes.unsubscribe(shopId, endpoint('a'))).toBe(true);
    expect(await pushes.subscriberCount(tenant)).toBe(0);
    // Without Hatti's keys, nothing is kept and nothing sent.
    const off = new ShopperPushService(db, null);
    expect([off.on, await off.subscribe(shopId, { endpoint: endpoint('c') })]).toEqual([
      false,
      null,
    ]);
    expect((await off.send(tenant, { title: 'Sale', body: 'Now' })).ok).toBe(false);
  });

  it('sends a campaign to every browser, a batch at a time in marketing hours, forgetting those gone', async () => {
    for (const name of ['a', 'b', 'c', 'd', 'e']) await subscribe(name);
    await subscribe('z', other);
    sender.answers.set(endpoint('b'), 'gone');
    sender.answers.set(endpoint('c'), 'failed');

    const sent = await pushes.send(tenant, {
      title: ' Eid sale ',
      body: '30% off lawn, today only',
      path: '/collections/eid',
    });
    if (!sent.ok) throw new Error('not sent');
    expect(sent.value).toMatchObject({
      title: 'Eid sale',
      path: '/collections/eid',
      status: 'sending',
      sent: 0,
    });
    expect(await pushes.due()).toEqual([{ shopId, id: sent.value.id }]);

    // Out of marketing hours, it waits for the morning.
    expect(await pushes.pushNext(shopId, sent.value.id, NIGHT)).toEqual({
      outcome: 'waiting',
      until: new Date('2026-10-28T05:00:00Z'),
    });
    expect(sender.sent).toEqual([]);
    // a went, b's subscription is gone, c failed.
    expect(await pushes.pushNext(shopId, sent.value.id, AFTERNOON, 3)).toEqual({
      outcome: 'pushed',
      sent: 1,
      done: false,
    });
    expect(await pushes.pushNext(shopId, sent.value.id, AFTERNOON, 3)).toEqual({
      outcome: 'pushed',
      sent: 2,
      done: true,
    });
    // Each of the shop's browsers once, none of another shop's.
    expect(sender.sent.map((each) => each.endpoint)).toEqual(
      ['a', 'b', 'c', 'd', 'e'].map(endpoint),
    );
    expect(sender.sent[0]!.message).toEqual({
      title: 'Eid sale',
      body: '30% off lawn, today only',
      url: '/collections/eid',
      tag: `pcmp_${sent.value.id}`.slice(0, 64),
    });
    expect(await pushes.pushNext(shopId, sent.value.id, AFTERNOON)).toEqual({ outcome: 'none' });
    expect(await pushes.due()).toEqual([]);
    const [campaign] = await pushes.campaigns(tenant);
    expect(campaign).toMatchObject({ status: 'sent', sent: 3, failed: 1, gone: 1 });
    expect(campaign!.sentAt).toEqual(AFTERNOON);
    // The browser gone is forgotten; the one that failed kept, to try again.
    expect(await pushes.subscriberCount(tenant)).toBe(4);
  });

  it('gives up a browser that fails too often in a row', async () => {
    await subscribe('a');
    sender.answers.set(endpoint('a'), 'failed');
    await admin.query(`UPDATE messaging.shopper_push_subscriptions SET failures = $1`, [
      SHOPPER_PUSH_LIMITS.failures - 1,
    ]);
    const sent = await pushes.send(tenant, { title: 'Sale', body: 'Now' });
    if (!sent.ok) throw new Error('not sent');
    expect(sent.value.path).toBe('/');
    await pushes.pushNext(shopId, sent.value.id, AFTERNOON);
    expect(await pushes.subscriberCount(tenant)).toBe(0);
  });

  it("opens the shop's own pages alone, says what is wrong, and sends a few a day", async () => {
    const fields = async (input: Parameters<ShopperPushService['send']>[1]) => {
      const result = await pushes.send(tenant, input);
      return result.ok ? [] : result.errors.map((error) => [error.field.join('.'), error.code]);
    };
    expect(await fields({ title: '', body: 'x'.repeat(181), path: '//evil.example' })).toEqual([
      ['input.title', 'BLANK'],
      ['input.body', 'TOO_LONG'],
      ['input.path', 'INVALID'],
    ]);
    expect(await fields({ title: 'Sale', body: 'Now', path: 'https://evil.example/' })).toEqual([
      ['input.path', 'INVALID'],
    ]);
    for (let sent = 0; sent < SHOPPER_PUSH_LIMITS.perDay; sent++) {
      expect(
        await fields({ title: `Sale ${sent}`, body: 'Now', path: '/collections/all' }),
      ).toEqual([]);
    }
    expect(await fields({ title: 'One more', body: 'Now' })).toEqual([['input', 'TOO_MANY']]);
    expect((await pushes.campaigns(tenant)).map((each) => each.title)).toEqual([
      'Sale 2',
      'Sale 1',
      'Sale 0',
    ]);
    // Another shop's day is its own.
    expect((await pushes.send(staff(other), { title: 'Mine', body: 'Now' })).ok).toBe(true);
  });
});
