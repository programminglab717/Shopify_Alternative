import 'reflect-metadata';
import {
  STAFF_ROLES,
  staffCapabilities,
  staffScopes,
  type StaffRole,
  type TenantContext,
} from '@hatti/api';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  PUSH_KINDS,
  PUSH_LIMITS,
  PUSH_ROLES,
  PushService,
  pushedTo,
  type PushMessage,
  type PushRecipient,
} from './push.service.js';
import { generateVapidKeys, type PushOutcome, type WebPushSender } from './web-push.js';

const server = testDatabaseServer();

/** A push service's sender, each push kept, answering as each endpoint is told to. */
class FakeSender {
  readonly publicKey = generateVapidKeys().publicKey;
  readonly sent: { endpoint: string; message: Record<string, string>; urgency?: string }[] = [];
  readonly answers = new Map<string, PushOutcome>();

  send(
    subscription: { endpoint: string },
    message: object,
    options: { urgency?: 'high' | 'normal' } = {},
  ): Promise<PushOutcome> {
    this.sent.push({
      endpoint: subscription.endpoint,
      message: message as Record<string, string>,
      urgency: options.urgency,
    });
    return Promise.resolve(this.answers.get(subscription.endpoint) ?? 'sent');
  }
}

const P256DH = 'B'.repeat(87);
const AUTH = 'a'.repeat(22);
const endpoint = (name: string) => `https://fcm.googleapis.com/fcm/send/${name}`;

function staff(shopId: string, userId: string, role: StaffRole = 'owner'): TenantContext {
  return {
    shopId,
    currency: 'PKR',
    actor: {
      kind: 'staff',
      userId,
      sessionId: newId(),
      authenticatedAt: new Date(),
      role,
    },
    scopes: new Set(),
  };
}

/** A member of staff to tell: a preset's, or a custom role's holding `custom` (ADR-578). */
function recipient(
  userId: string,
  role: StaffRole,
  language: 'en' | 'ur' = 'en',
  custom: { scopes: string[]; capabilities: string[] } | null = null,
): PushRecipient {
  return {
    userId,
    role,
    language,
    scopes: staffScopes(role, custom?.scopes ?? null),
    capabilities: staffCapabilities(role, custom?.capabilities ?? null),
  };
}

describe('Whom each kind of news is pushed to (ADR-581)', () => {
  it("tells every preset's member whose role it is for, as before", () => {
    for (const kind of PUSH_KINDS) {
      for (const role of STAFF_ROLES) {
        expect([kind, role, pushedTo(kind, recipient('usr', role))]).toEqual([
          kind,
          role,
          PUSH_ROLES[kind].includes(role),
        ]);
      }
    }
  });

  it("tells a custom role's member only of the work they may do", () => {
    const lead = recipient('usr', 'manager', 'en', {
      scopes: ['write_orders', 'read_inventory'],
      capabilities: ['assign_orders'],
    });
    expect(PUSH_KINDS.filter((kind) => pushedTo(kind, lead))).toEqual([
      'new_order',
      'needs_review',
    ]);
    const books = recipient('usr', 'accountant', 'en', {
      scopes: ['read_orders'],
      capabilities: ['reconcile_payments'],
    });
    expect(PUSH_KINDS.filter((kind) => pushedTo(kind, books))).toEqual(['cash_remitted']);
    // Never beyond their preset's roles, whatever they hold.
    const caller = recipient('usr', 'confirmation_agent', 'en', {
      scopes: ['write_orders'],
      capabilities: [],
    });
    expect(PUSH_KINDS.filter((kind) => pushedTo(kind, caller))).toEqual([
      'new_order',
      'needs_review',
    ]);
  });

  it('tells who answers customers of a message through the contact form (ADR-591)', () => {
    const told = (role: StaffRole, scopes?: string[]) =>
      pushedTo(
        'contact_message',
        recipient('usr', role, 'en', scopes ? { scopes, capabilities: [] } : null),
      );
    expect([told('owner'), told('manager'), told('confirmation_agent')]).toEqual([
      true,
      true,
      true,
    ]);
    expect([told('marketer'), told('packer'), told('accountant')]).toEqual([false, false, false]);
    // A custom role's member, only where they may answer.
    expect([
      told('manager', ['read_conversations']),
      told('manager', ['write_conversations']),
    ]).toEqual([false, true]);
  });

  it("tells who writes the shop's blogs of a comment waiting for approval (ADR-619)", () => {
    const told = (role: StaffRole, scopes?: string[]) =>
      pushedTo(
        'comment_pending',
        recipient('usr', role, 'en', scopes ? { scopes, capabilities: [] } : null),
      );
    expect([told('owner'), told('manager'), told('marketer')]).toEqual([true, true, true]);
    expect([told('confirmation_agent'), told('packer'), told('accountant')]).toEqual([
      false,
      false,
      false,
    ]);
    expect([told('marketer', ['read_content']), told('marketer', ['write_content'])]).toEqual([
      false,
      true,
    ]);
  });
});

const message: PushMessage = {
  en: { title: 'New order #1001', body: 'Rs 4,500 from Lahore' },
  ur: { title: 'نیا آرڈر', body: 'لاہور سے' },
  url: '/zari/orders/1',
};

describe.skipIf(!server)("Push notifications to staff's browsers (APP-03, ADR-506)", () => {
  let testDb: TestDatabase;
  let db: Database;
  let admin: pg.Client;
  let sender: FakeSender;
  let push: PushService;
  const shopId = newId();
  const owner = newId();
  const agent = newId();
  const packer = newId();

  beforeAll(async () => {
    testDb = await createTestDatabase(server!);
    db = new Database({
      appUrl: testDb.appUrl,
      systemUrl: testDb.systemUrl,
      applicationName: 'push-test',
    });
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'Zari')`, [shopId]);
  });

  beforeEach(async () => {
    await admin.query('DELETE FROM messaging.push_subscriptions');
    await admin.query('DELETE FROM messaging.push_deliveries');
    sender = new FakeSender();
    push = new PushService(db, sender as unknown as WebPushSender);
  });

  afterAll(async () => {
    await db?.close();
    await admin?.end();
    await testDb?.drop();
  });

  const subscribe = (userId: string, name: string, kinds: string[], role?: StaffRole) =>
    push.subscribe(staff(shopId, userId, role), {
      endpoint: endpoint(name),
      p256dh: P256DH,
      auth: AUTH,
      kinds,
    });

  it("keeps a browser's subscription for staff alone, its kinds checked", async () => {
    expect(await subscribe(owner, 'phone', ['new_order', 'new_order', 'low_stock'])).toMatchObject({
      ok: true,
      value: { endpoint: endpoint('phone'), kinds: ['new_order', 'low_stock'] },
    });
    expect(await subscribe(owner, 'phone', ['gossip'])).toMatchObject({
      ok: false,
      errors: [{ field: ['input', 'kinds'], code: 'INVALID' }],
    });
    expect(
      await push.subscribe(staff(shopId, owner), {
        endpoint: 'http://push.example/x',
        p256dh: P256DH,
        auth: AUTH,
        kinds: [],
      }),
    ).toMatchObject({ ok: false, errors: [{ field: ['input', 'endpoint'] }] });
    expect(
      await push.subscribe(staff(shopId, owner), {
        endpoint: endpoint('phone'),
        p256dh: 'short',
        auth: AUTH,
        kinds: [],
      }),
    ).toMatchObject({ ok: false, errors: [{ field: ['input', 'p256dh'] }] });
    const app: TenantContext = {
      ...staff(shopId, owner),
      actor: { kind: 'app', tokenId: newId() },
    };
    expect(
      await push.subscribe(app, { endpoint: endpoint('x'), p256dh: P256DH, auth: AUTH, kinds: [] }),
    ).toMatchObject({ ok: false });
    expect(push.publicKey).toBe(sender.publicKey);

    const off = new PushService(db, null);
    expect(off.publicKey).toBeNull();
    expect(
      await off.subscribe(staff(shopId, owner), {
        endpoint: endpoint('x'),
        p256dh: P256DH,
        auth: AUTH,
        kinds: [],
      }),
    ).toMatchObject({ ok: false });
  });

  it('gives a browser to whoever signed in on it last, and turns it off for them alone', async () => {
    await subscribe(owner, 'shared', ['new_order']);
    await subscribe(agent, 'shared', ['needs_review'], 'confirmation_agent');
    expect(await push.subscriptionOf(staff(shopId, owner), endpoint('shared'))).toBeNull();
    expect(await push.subscriptionOf(staff(shopId, agent), endpoint('shared'))).toMatchObject({
      kinds: ['needs_review'],
    });
    expect(await push.unsubscribe(staff(shopId, owner), endpoint('shared'))).toBe(false);
    expect(await push.unsubscribe(staff(shopId, agent), endpoint('shared'))).toBe(true);
    expect(await push.subscriptionOf(staff(shopId, agent), endpoint('shared'))).toBeNull();
  });

  it('pushes to the roles whose work it is, who chose it, in their language, once', async () => {
    await subscribe(owner, 'owner-phone', ['new_order', 'low_stock']);
    await subscribe(owner, 'owner-laptop', ['low_stock']);
    await subscribe(agent, 'agent-phone', ['new_order']);
    await subscribe(packer, 'packer-phone', ['new_order']);
    const recipients = [
      recipient(owner, 'owner'),
      recipient(agent, 'confirmation_agent', 'ur'),
      recipient(packer, 'packer'),
    ];

    expect(await push.push(shopId, 'new_order', 'order:1', recipients, message)).toBe(2);
    expect(sender.sent.map((each) => each.endpoint).sort()).toEqual([
      endpoint('agent-phone'),
      endpoint('owner-phone'),
    ]);
    const byEndpoint = new Map(sender.sent.map((each) => [each.endpoint, each]));
    expect(byEndpoint.get(endpoint('owner-phone'))).toEqual({
      endpoint: endpoint('owner-phone'),
      message: { ...message.en, url: message.url, tag: 'order:1' },
      urgency: 'high',
    });
    expect(byEndpoint.get(endpoint('agent-phone'))!.message.title).toBe(message.ur.title);

    // Heard again: pushed once.
    expect(await push.push(shopId, 'new_order', 'order:1', recipients, message)).toBe(0);
    expect(sender.sent).toHaveLength(2);

    expect(await push.push(shopId, 'low_stock', 'low:1', recipients, message)).toBe(2);
    // A custom role's member without the stock's work is not told of it (ADR-581).
    expect(
      await push.push(
        shopId,
        'low_stock',
        'low:2',
        [recipient(owner, 'manager', 'en', { scopes: ['write_orders'], capabilities: [] })],
        message,
      ),
    ).toBe(0);
    expect(sender.sent.slice(2).every((each) => each.urgency === 'normal')).toBe(true);
    const { rows } = await admin.query<{ last_sent_at: Date | null }>(
      `SELECT last_sent_at FROM messaging.push_subscriptions WHERE endpoint = $1`,
      [endpoint('owner-laptop')],
    );
    expect(rows[0]!.last_sent_at).toBeInstanceOf(Date);
  });

  it('forgets a subscription that is gone, and one that failed too often', async () => {
    await subscribe(owner, 'gone', ['cash_remitted']);
    await subscribe(owner, 'flaky', ['cash_remitted']);
    await subscribe(owner, 'fine', ['cash_remitted']);
    sender.answers.set(endpoint('gone'), 'gone');
    sender.answers.set(endpoint('flaky'), 'failed');
    const recipients = [recipient(owner, 'owner')];

    expect(await push.push(shopId, 'cash_remitted', 'cash:1', recipients, message)).toBe(1);
    const left = async () =>
      (
        await admin.query<{ endpoint: string; failures: number }>(
          `SELECT endpoint, failures FROM messaging.push_subscriptions ORDER BY endpoint`,
        )
      ).rows;
    expect(await left()).toEqual([
      { endpoint: endpoint('fine'), failures: 0 },
      { endpoint: endpoint('flaky'), failures: 1 },
    ]);

    await admin.query(`UPDATE messaging.push_subscriptions SET failures = $1 WHERE endpoint = $2`, [
      PUSH_LIMITS.failures - 1,
      endpoint('flaky'),
    ]);
    await push.push(shopId, 'cash_remitted', 'cash:2', recipients, message);
    expect(await left()).toEqual([{ endpoint: endpoint('fine'), failures: 0 }]);

    // Subscribing again starts its count afresh.
    await admin.query(`UPDATE messaging.push_subscriptions SET failures = 5`);
    await subscribe(owner, 'fine', ['cash_remitted']);
    expect(await left()).toEqual([{ endpoint: endpoint('fine'), failures: 0 }]);
  });
});
