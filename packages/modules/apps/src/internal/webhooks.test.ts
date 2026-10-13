import 'reflect-metadata';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ROLE_SCOPES, type MutationResult, type TenantContext } from '@hatti/api';
import { SecretBox } from '@hatti/crypto';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import type { DomainEvent } from '@hatti/events';
import { newId, toPublicId } from '@hatti/ids';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CustomAppService } from './custom-apps.service.js';
import { HttpWebhookSender } from './webhook-sender.js';
import {
  WEBHOOK_EVENTS,
  retryDelayMs,
  signWebhook,
  topicsOf,
  uriProblem,
  webhookBody,
} from './webhooks.js';
import { WebhookService } from './webhooks.service.js';

const server = testDatabaseServer();
const HOUR = 3_600_000;

function unwrap<T>(result: MutationResult<T>): T {
  if (!result.ok) throw new Error(`Refused: ${JSON.stringify(result.errors)}`);
  return result.value;
}

function refusals<T>(result: MutationResult<T>) {
  return result.ok ? [] : result.errors.map((error) => [error.field, error.code]);
}

function event(shopId: string, type: string, aggregateType: string, extra = {}): DomainEvent {
  return {
    id: newId(),
    shopId,
    type,
    aggregateType,
    aggregateId: newId(),
    occurredAt: '2026-10-13T10:00:00.000Z',
    payload: {},
    ...extra,
  };
}

describe('Webhooks: topics, bodies and signatures (DEV-03, ADR-397)', () => {
  it("names each event's topics and what a delivery says of it", () => {
    expect(topicsOf('order.cancelled')).toEqual(['orders/updated', 'orders/cancelled']);
    expect(topicsOf('order.comment_created')).toEqual([]);
    expect(WEBHOOK_EVENTS).toContain('inventory_level.updated');

    const shopId = newId();
    const order = event(shopId, 'order.created', 'order');
    expect(webhookBody('orders/create', order)).toEqual({
      topic: 'orders/create',
      event_id: toPublicId('event', order.id),
      occurred_at: '2026-10-13T10:00:00.000Z',
      shop_id: toPublicId('shop', shopId),
      data: { id: toPublicId('order', order.aggregateId) },
    });
    const [variant, location] = [newId(), newId()];
    const level = event(shopId, 'inventory_level.updated', 'inventory_level', {
      payload: { inventoryItemId: variant, locationId: location, available: 7, onHand: 9 },
    });
    expect(webhookBody('inventory_levels/update', level)!.data).toEqual({
      inventory_item_id: toPublicId('inventoryItem', variant),
      location_id: toPublicId('location', location),
      available: 7,
    });
    // Nothing a webhook tells of.
    expect(
      webhookBody('orders/create', event(shopId, 'order.created', 'order_settings')),
    ).toBeNull();
  });

  it('signs a body as Shopify does, and waits longer between each try', () => {
    // The HMAC-SHA256 of the body with the secret, in base64.
    expect(signWebhook('hws_secret', '{"a":1}')).toBe(
      'Fk1cT/DwnE4h3MSUWi8+0KYv5VZuX31ZunIHtKshpUU=',
    );
    expect([1, 2, 3, 9, 10, 20].map((attempts) => retryDelayMs(attempts) / 60_000)).toEqual([
      1, 2, 4, 256, 360, 360,
    ]);
    expect(uriProblem('https://sheets.example.pk/hooks/orders')).toBeNull();
    expect(uriProblem('http://sheets.example.pk/hooks')).toBe('must be an https address');
    expect(uriProblem('https://localhost/hooks')).toBe('must be on the public internet');
    expect(uriProblem('https://user:pass@sheets.example.pk/')).toBe(
      "can't have a user name or password",
    );
    expect(uriProblem('sheets')).toBe('is not an address');
  });
});

describe.skipIf(!server)('Webhooks: subscriptions and deliveries (DEV-03, ADR-397)', () => {
  let testDb: TestDatabase;
  let db: Database;
  let admin: pg.Client;
  let apps: CustomAppService;
  let webhooks: WebhookService;
  let hook: Server;
  let hookUrl: string;
  /** What the app's server was posted, and what it answers next. */
  let received: { headers: IncomingHttpHeaders; body: string }[] = [];
  let answers: number[] = [];
  const sender = new HttpWebhookSender({
    protocols: ['http:', 'https:'],
    allowAddress: () => true,
  });
  const shopA = newId();
  const shopB = newId();
  const owner: TenantContext = {
    shopId: shopA,
    currency: 'PKR',
    scopes: new Set(ROLE_SCOPES.owner),
    actor: {
      kind: 'staff',
      userId: newId(),
      sessionId: newId(),
      role: 'owner',
      authenticatedAt: new Date(),
    },
  };

  beforeAll(async () => {
    testDb = await createTestDatabase(server!);
    db = new Database({
      appUrl: testDb.appUrl,
      systemUrl: testDb.systemUrl,
      applicationName: 'webhooks-test',
    });
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'A'), ($2, 'B')`, [
      shopA,
      shopB,
    ]);
    const box = SecretBox.fromString(`k1:${SecretBox.generateKey()}`);
    apps = new CustomAppService(db, box);
    webhooks = new WebhookService(db, box);
    hook = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
      request.on('end', () => {
        received.push({ headers: request.headers, body });
        response.statusCode = answers.shift() ?? 200;
        response.end('ok');
      });
    });
    await new Promise<void>((resolve) => hook.listen(0, '127.0.0.1', resolve));
    hookUrl = `http://127.0.0.1:${(hook.address() as AddressInfo).port}/hooks`;
  });

  afterAll(async () => {
    await new Promise((resolve) => hook?.close(resolve));
    await db?.close();
    await admin?.end();
    await testDb?.drop();
  });

  beforeEach(async () => {
    received = [];
    answers = [];
    await admin.query(
      'DELETE FROM apps.webhook_deliveries; DELETE FROM apps.webhook_subscriptions; ' +
        'DELETE FROM apps.access_tokens; DELETE FROM platform.outbox_events',
    );
  });

  /** An app with `scopes`, as an app calling the API; and its secret. */
  async function app(scopes: string[]) {
    const made = unwrap(await apps.create(owner, { name: 'Sheet sync', scopes }));
    const tenant: TenantContext = {
      shopId: shopA,
      currency: 'PKR',
      scopes: new Set(scopes),
      actor: { kind: 'app', tokenId: made.app.id },
    };
    return { id: made.app.id, secret: made.webhookSecret, tenant };
  }

  /** A subscription at the test's own server, which the API would refuse for plain http. */
  async function subscribedHere(appId: string, topic: string) {
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO apps.webhook_subscriptions (shop_id, app_id, topic, uri)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [shopA, appId, topic, hookUrl],
    );
    return rows[0]!.id;
  }

  async function deliveries() {
    const { rows } = await admin.query<{
      topic: string;
      status: string;
      attempts: number;
      response_status: number | null;
      error: string | null;
    }>(
      `SELECT topic, status, attempts, response_status, error
         FROM apps.webhook_deliveries ORDER BY created_at, topic`,
    );
    return rows;
  }

  it('subscribes an app to topics it may read, at https addresses, and ends them', async () => {
    const sheet = await app(['read_orders']);
    const made = unwrap(
      await webhooks.create(sheet.tenant, sheet.id, {
        topic: 'orders/create',
        uri: 'https://sheets.example.pk/hooks/orders',
      }),
    );
    expect(made).toMatchObject({
      appId: sheet.id,
      appName: 'Sheet sync',
      topic: 'orders/create',
      uri: 'https://sheets.example.pk/hooks/orders',
    });
    expect(
      refusals(
        await webhooks.create(sheet.tenant, sheet.id, {
          topic: 'orders/create',
          uri: 'https://sheets.example.pk/hooks/orders',
        }),
      ),
    ).toEqual([[['webhookSubscription', 'callbackUrl'], 'TAKEN']]);
    // Products it cannot read; an address not https; a topic there is not.
    expect(
      refusals(
        await webhooks.create(sheet.tenant, sheet.id, {
          topic: 'products/create',
          uri: 'https://sheets.example.pk/hooks/products',
        }),
      ),
    ).toEqual([[['topic'], 'INVALID']]);
    expect(
      refusals(
        await webhooks.create(sheet.tenant, sheet.id, {
          topic: 'orders/explode',
          uri: 'http://sheets.example.pk/',
        }),
      ),
    ).toEqual([
      [['topic'], 'INVALID'],
      [['webhookSubscription', 'callbackUrl'], 'INVALID'],
    ]);
    // Its own uninstalling needs no scope.
    unwrap(
      await webhooks.create(sheet.tenant, sheet.id, {
        topic: 'app/uninstalled',
        uri: 'https://sheets.example.pk/hooks/gone',
      }),
    );

    // Another app sees none of them; the owner sees both apps'.
    const other = await app(['read_products']);
    expect(await webhooks.list(other.tenant, other.id)).toEqual([]);
    expect((await webhooks.list(owner, null)).map((each) => each.topic)).toEqual([
      'app/uninstalled',
      'orders/create',
    ]);
    expect(
      refusals(await webhooks.update(other.tenant, made.id, other.id, { uri: 'https://x.pk/h' })),
    ).toEqual([[['id'], 'NOT_FOUND']]);

    const moved = unwrap(
      await webhooks.update(sheet.tenant, made.id, sheet.id, {
        uri: 'https://sheets.example.pk/v2',
      }),
    );
    expect(moved.uri).toBe('https://sheets.example.pk/v2');
    unwrap(await webhooks.delete(owner, made.id, null));
    expect((await webhooks.list(sheet.tenant, sheet.id)).map((each) => each.topic)).toEqual([
      'app/uninstalled',
    ]);
    const { rows } = await admin.query<{ event_type: string }>(
      `SELECT event_type FROM platform.outbox_events
        WHERE event_type LIKE 'webhook_subscription.%' ORDER BY id`,
    );
    expect(rows.map((row) => row.event_type)).toEqual([
      'webhook_subscription.created',
      'webhook_subscription.created',
      'webhook_subscription.updated',
      'webhook_subscription.deleted',
    ]);
  });

  it('posts each event once to the apps that may read it, signed with their secret', async () => {
    const sheet = await app(['read_orders']);
    await subscribedHere(sheet.id, 'orders/create');
    await subscribedHere(sheet.id, 'orders/updated');
    // An app subscribed before its orders scope was taken away hears nothing.
    const blind = await app(['read_orders']);
    await subscribedHere(blind.id, 'orders/create');
    unwrap(await apps.update(owner, blind.id, { scopes: ['read_products'] }));

    const created = event(shopA, 'order.created', 'order');
    expect(await webhooks.fanOut(created)).toBe(1);
    // The same event again makes nothing more; another shop's, nothing here.
    expect(await webhooks.fanOut(created)).toBe(0);
    expect(await webhooks.fanOut(event(shopB, 'order.created', 'order'))).toBe(0);

    expect(await webhooks.deliverDue(sender)).toEqual({ delivered: 1, retrying: 0, failed: 0 });
    const [posted] = received;
    expect(posted!.headers).toMatchObject({
      'content-type': 'application/json',
      'x-hatti-topic': 'orders/create',
      'x-hatti-shop-id': toPublicId('shop', shopA),
      'x-hatti-event-id': toPublicId('event', created.id),
    });
    expect(posted!.headers['x-hatti-hmac-sha256']).toBe(signWebhook(sheet.secret, posted!.body));
    expect(JSON.parse(posted!.body)).toMatchObject({
      topic: 'orders/create',
      data: { id: toPublicId('order', created.aggregateId) },
    });
    expect(await deliveries()).toEqual([
      {
        topic: 'orders/create',
        status: 'delivered',
        attempts: 1,
        response_status: 200,
        error: null,
      },
    ]);
    // Nothing more is due.
    expect(await webhooks.deliverDue(sender)).toEqual({ delivered: 0, retrying: 0, failed: 0 });
  });

  it('tries a failed delivery again later, and gives up after two days', async () => {
    const sheet = await app(['read_orders']);
    await subscribedHere(sheet.id, 'orders/paid');
    await webhooks.fanOut(event(shopA, 'order.paid', 'order'));

    answers = [500];
    const now = Date.now();
    expect(await webhooks.deliverDue(sender, new Date(now))).toEqual({
      delivered: 0,
      retrying: 1,
      failed: 0,
    });
    expect(await deliveries()).toMatchObject([
      { status: 'pending', attempts: 1, response_status: 500, error: 'It answered 500' },
    ]);
    // Not due again for a minute; then delivered.
    expect(await webhooks.deliverDue(sender, new Date(now + 30_000))).toMatchObject({
      retrying: 0,
      delivered: 0,
    });
    expect(await webhooks.deliverDue(sender, new Date(now + 61_000))).toMatchObject({
      delivered: 1,
    });

    // Another that never gets an answer it can take, tried past two days.
    await webhooks.fanOut(event(shopA, 'order.paid', 'order'));
    answers = [503, 503];
    await webhooks.deliverDue(sender, new Date(now + 2 * 60_000));
    expect(await webhooks.deliverDue(sender, new Date(now + 49 * HOUR))).toEqual({
      delivered: 0,
      retrying: 0,
      failed: 1,
    });
    expect((await deliveries()).map((each) => each.status)).toEqual(['delivered', 'failed']);
  });

  it("tells an app it was removed, and posts nothing more of the shop's to it", async () => {
    const sheet = await app(['read_orders']);
    await subscribedHere(sheet.id, 'orders/create');
    await subscribedHere(sheet.id, 'app/uninstalled');
    await webhooks.fanOut(event(shopA, 'order.created', 'order'));
    unwrap(await apps.delete(owner, sheet.id));
    // Its removal, as the worker hears it.
    const removed = event(shopA, 'app.deleted', 'app', { aggregateId: sheet.id });
    expect(await webhooks.fanOut(removed)).toBe(1);
    expect(await webhooks.fanOut(event(shopA, 'order.created', 'order'))).toBe(0);

    expect(await webhooks.deliverDue(sender)).toEqual({ delivered: 1, retrying: 0, failed: 1 });
    expect(await deliveries()).toMatchObject([
      { topic: 'orders/create', status: 'failed', error: 'The app was removed' },
      { topic: 'app/uninstalled', status: 'delivered' },
    ]);
    expect(received.map((each) => each.headers['x-hatti-topic'])).toEqual(['app/uninstalled']);
    expect(JSON.parse(received[0]!.body).data).toEqual({ id: toPublicId('accessToken', sheet.id) });
  });

  it('refuses addresses on private networks when it posts', async () => {
    const strict = new HttpWebhookSender({ protocols: ['http:', 'https:'] });
    expect(await strict.send({ url: hookUrl, body: '{}', headers: {} })).toEqual({
      status: null,
      error: 'Its address is not on the public internet',
    });
    const resolvesPrivately = new HttpWebhookSender({
      resolve: async () => [{ address: '10.0.0.7', family: 4 }],
    });
    expect(
      await resolvesPrivately.send({ url: 'https://hooks.example.pk/', body: '{}', headers: {} }),
    ).toEqual({ status: null, error: 'Its address is not on the public internet' });
    expect(
      await new HttpWebhookSender().send({
        url: 'http://hooks.example.pk/',
        body: '{}',
        headers: {},
      }),
    ).toEqual({ status: null, error: 'Only https addresses are posted to' });
    expect(received).toEqual([]);
  });
});
