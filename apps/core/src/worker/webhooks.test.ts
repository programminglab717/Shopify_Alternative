import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ROLE_SCOPES, type TenantContext } from '@hatti/api';
import {
  CustomAppService,
  HttpWebhookSender,
  WebhookService,
  signWebhook,
} from '@hatti/apps/public';
import { SecretBox } from '@hatti/crypto';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import type { DomainEvent } from '@hatti/events';
import { newId, toPublicId } from '@hatti/ids';
import { createLogger } from '@hatti/logger';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventHandlers } from './start-worker.js';
import { WebhookDeliveries, WebhookFanOut } from './webhooks.js';

const server = testDatabaseServer();

describe.skipIf(!server)("Apps' webhooks in the worker (DEV-03, ADR-397)", () => {
  let testDb: TestDatabase;
  let database: Database;
  let admin: pg.Client;
  let hook: Server;
  let hookUrl: string;
  const received: { headers: IncomingHttpHeaders; body: string }[] = [];
  const shopId = newId();
  const box = SecretBox.fromString(`k1:${SecretBox.generateKey()}`);

  beforeAll(async () => {
    testDb = await createTestDatabase(server!);
    database = new Database({
      appUrl: testDb.appUrl,
      systemUrl: testDb.systemUrl,
      applicationName: 'webhooks-worker-test',
    });
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'Zari')`, [shopId]);
    hook = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
      request.on('end', () => {
        received.push({ headers: request.headers, body });
        response.end();
      });
    });
    await new Promise<void>((resolve) => hook.listen(0, '127.0.0.1', resolve));
    hookUrl = `http://127.0.0.1:${(hook.address() as AddressInfo).port}/orders`;
  });

  afterAll(async () => {
    await new Promise((resolve) => hook?.close(resolve));
    await database?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it("posts an order's event to the app subscribed to it, as the event reaches the worker", async () => {
    const owner: TenantContext = {
      shopId,
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
    const made = await new CustomAppService(database, box).create(owner, {
      name: 'Orders sheet',
      scopes: ['read_orders'],
    });
    if (!made.ok) throw new Error('app not made');
    await admin.query(
      `INSERT INTO apps.webhook_subscriptions (shop_id, app_id, topic, uri)
       VALUES ($1, $2, 'orders/create', $3)`,
      [shopId, made.value.app.id, hookUrl],
    );
    const webhooks = new WebhookService(database, box);
    const handlers = eventHandlers(createLogger({ name: 'worker', level: 'silent' }), {
      webhooks: new WebhookFanOut(webhooks),
    });
    const event: DomainEvent = {
      id: newId(),
      type: 'order.created',
      shopId,
      aggregateType: 'order',
      aggregateId: newId(),
      payload: {},
      occurredAt: new Date().toISOString(),
    };
    await handlers.dispatch(event);

    const sweep = new WebhookDeliveries(
      webhooks,
      new HttpWebhookSender({ protocols: ['http:'], allowAddress: () => true }),
    );
    expect(await sweep.sweep()).toEqual({ delivered: 1, retrying: 0, failed: 0 });
    const [posted] = received;
    expect(posted!.headers['x-hatti-topic']).toBe('orders/create');
    expect(posted!.headers['x-hatti-hmac-sha256']).toBe(
      signWebhook(made.value.webhookSecret, posted!.body),
    );
    expect(JSON.parse(posted!.body).data).toEqual({ id: toPublicId('order', event.aggregateId) });
  });
});
