import 'reflect-metadata';
import { AiGateway } from '@hatti/ai';
import {
  AiCredits,
  StorefrontSite,
  type AiCreditBalance,
  type AiCreditUse,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import { ProductService, VariantService } from '@hatti/catalog/public';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import type { DomainEvent } from '@hatti/events';
import { newId } from '@hatti/ids';
import { InventoryService, LocationService } from '@hatti/inventory/public';
import {
  ConversationsService,
  MessagingEvents,
  SupportAgentService,
  WebChatService,
} from '@hatti/messaging/public';
import { DomainService, PolicyService } from '@hatti/online-store/public';
import type { OrderService } from '@hatti/orders/public';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AiCustomerReplies, orderNumbersIn } from './ai-customer-replies.js';
import { workerOrders } from './unreachable-orders.js';

const server = testDatabaseServer();

function unwrap<T>(result: MutationResult<T> | null): T {
  if (!result?.ok) throw new Error(JSON.stringify(result));
  return result.value;
}

function tenant(shopId: string): TenantContext {
  return {
    shopId,
    currency: 'PKR',
    actor: { kind: 'app', tokenId: newId() },
    scopes: new Set(['write_products', 'write_inventory', 'write_orders', 'write_settings']),
  };
}

/** A plan's AI credits, each spend kept. */
class Credits extends AiCredits {
  left = 10;
  readonly spent: AiCreditUse[] = [];
  balanceOf(): Promise<AiCreditBalance> {
    return Promise.resolve({
      perMonth: 10,
      used: 10 - this.left,
      bought: 0,
      left: this.left,
      plan: 'Free',
      renewsAt: new Date('2026-11-01T00:00:00+05:00'),
    });
  }
  spend(_shopId: string, use: AiCreditUse) {
    this.spent.push(use);
    this.left -= 1;
    return Promise.resolve();
  }
}

describe('Orders', () => {
  it('finds the order numbers a shopper wrote in the chat', () => {
    expect(
      orderNumbersIn([
        { from: 'customer', text: 'Mera order #1023 kahan hai? aur order no. 1024 bhi' },
        { from: 'shop', text: 'Order #9999 is ours' },
        { from: 'customer', text: 'order number 1023 again, and 12' },
      ]),
    ).toEqual([1023, 1024]);
  });
});

describe.skipIf(!server)('Customers answered by the AI (MSG-07, ADR-849)', () => {
  let testDb: TestDatabase;
  let database: Database;
  let admin: pg.Client;
  let orders: OrderService;
  let chat: WebChatService;
  let agent: SupportAgentService;
  const owner = tenant(newId());
  let variantId = '';
  let phones = 0;
  /** What the AI answers next, and each prompt it was given. */
  let answer: unknown = { reply: 'Ji, aap ka order raaste mein hai.', hand_off: false };
  const prompts: string[] = [];
  const credits = new Credits();
  let replies: AiCustomerReplies;

  const gateway = new AiGateway({
    apiKey: 'sk-test',
    model: 'model',
    fetch: (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { messages: { content: string }[] };
      prompts.push(body.messages[0]!.content);
      return new Response(
        JSON.stringify({
          content: [{ type: 'tool_use', name: 'give_reply', input: answer }],
          stop_reason: 'tool_use',
          usage: { input_tokens: 800, output_tokens: 50 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof globalThis.fetch,
  });

  /** A chat a shopper starts from the online store with `body`, from a number of their own. */
  async function chatOf(body: string, phone = `0300 55566${String(phones++).padStart(2, '0')}`) {
    const started = unwrap(await chat.start(owner.shopId, { name: 'Ayesha', phone, body }));
    return { token: started.token, ...(await latest()) };
  }

  /** The latest message written, as its event names it. */
  async function latest(): Promise<{ conversationId: string; event: DomainEvent }> {
    const { rows } = await admin.query<{ conversation_id: string; id: string }>(
      `SELECT conversation_id, id FROM messaging.conversation_messages
        WHERE shop_id = $1 AND direction = 'inbound' ORDER BY at DESC, id DESC LIMIT 1`,
      [owner.shopId],
    );
    const { conversation_id: conversationId, id: messageId } = rows[0]!;
    return {
      conversationId,
      event: {
        id: newId(),
        type: MessagingEvents.ConversationMessageReceived,
        shopId: owner.shopId,
        aggregateType: 'conversation',
        aggregateId: conversationId,
        payload: { messageId, at: new Date().toISOString(), startedWaiting: true },
      } as unknown as DomainEvent,
    };
  }

  const outbound = async (conversationId: string) =>
    (
      await admin.query<{ body: string; actor_kind: string }>(
        `SELECT body, actor_kind FROM messaging.conversation_messages
          WHERE conversation_id = $1 AND direction = 'outbound' ORDER BY at, id`,
        [conversationId],
      )
    ).rows;

  beforeAll(async () => {
    testDb = await createTestDatabase(server!);
    database = new Database({
      appUrl: testDb.appUrl,
      systemUrl: testDb.systemUrl,
      applicationName: 'ai-customer-replies-test',
    });
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'Zari')`, [owner.shopId]);
    const policies = new PolicyService(
      database,
      new StorefrontSite('https://hatti.pk'),
      new DomainService(database, new StorefrontSite('https://hatti.pk'), {
        resolveCname: () => Promise.resolve([]),
        resolve4: () => Promise.resolve([]),
        resolve6: () => Promise.resolve([]),
      } as never),
    );
    unwrap(
      await policies.update(owner, {
        type: 'refund_policy',
        body: '<p>Returns within <strong>7 days</strong>, unworn.</p>',
      }),
    );
    unwrap(
      await policies.update(owner, { type: 'privacy_policy', body: '<p>We keep your number.</p>' }),
    );
    orders = workerOrders(database);
    chat = new WebChatService(database);
    agent = new SupportAgentService(database);
    unwrap(await chat.update(owner, { enabled: true }));
    replies = new AiCustomerReplies(
      database,
      agent,
      new ConversationsService(database),
      gateway,
      credits,
    );
    const product = unwrap(
      await new ProductService(database).create(owner, {
        title: 'Kurta',
        status: 'active',
        variants: [{ price: '2,000' }],
      }),
    );
    variantId = product.variants[0]!.id;
    const location = await new LocationService(database).primary(owner);
    unwrap(
      await new InventoryService(database, new VariantService(database)).setQuantities(owner, {
        name: 'on_hand',
        reason: 'received',
        quantities: [{ inventoryItemId: variantId, locationId: location.id, quantity: 20 }],
      }),
    );
  });

  afterAll(async () => {
    await database?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it("answers in the chat from the shop's policies and the order the shopper named, as the AI's", async () => {
    const order = unwrap(
      await orders.create(owner, {
        lineItems: [{ variantId, quantity: 1 }],
        shippingAddress: {
          name: 'Ayesha Khan',
          phone: '0300 5554400',
          address1: 'House 12, Street 4',
          city: 'Lahore',
        },
      }),
    );
    // Off: the AI answers no one.
    const before = await chatOf('hello?');
    expect(await replies.handle(before.event)).toBeNull();
    unwrap(await agent.update(owner, { enabled: true }));

    const asked = await chatOf(`Mera order #${order.number} kahan hai?`, '0300 5554400');
    expect(await replies.handle(asked.event)).toBe('replied');
    const prompt = prompts.at(-1)!;
    expect(prompt).toContain('refund policy: Returns within 7 days, unworn.');
    expect(prompt).not.toContain('We keep your number');
    expect(prompt).toContain(`Order #${order.number}, placed `);
    expect(prompt).toContain('cash on delivery');
    expect(prompt).toContain(`<customer>\nMera order #${order.number} kahan hai?\n</customer>`);
    expect(await outbound(asked.conversationId)).toEqual([
      { body: 'Ji, aap ka order raaste mein hai.', actor_kind: 'ai' },
    ]);
    // The shopper's chat reads it.
    const read = (await chat.read(owner.shopId, asked.token)) ?? [];
    expect(read.map((message) => message.body)).toContain('Ji, aap ka order raaste mein hai.');
    expect(credits.spent).toEqual(['support_reply']);
    // Once a message: heard again, nothing more.
    expect(await replies.handle(asked.event)).toBeNull();

    // An order not named, or named from another number, is not given.
    await chatOf(`order ${order.number} please`);
    const other = await latest();
    expect(await replies.handle(other.event)).toBe('replied');
    expect(prompts.at(-1)).toContain('No order of this customer is known');
  });

  it('hands the conversation to staff, and leaves it to them a day', async () => {
    answer = { reply: 'Someone from the shop will reply soon.', hand_off: true };
    const asked = await chatOf('I want a refund for my kurta');
    expect(await replies.handle(asked.event)).toBe('handed_off');
    const { rows } = await admin.query<{ waiting_since: Date | null; unread: number }>(
      'SELECT waiting_since, unread FROM messaging.conversations WHERE id = $1',
      [asked.conversationId],
    );
    expect(rows[0]!.waiting_since).not.toBeNull();
    expect(rows[0]!.unread).toBeGreaterThan(0);
    // The shopper writes again: theirs to answer now.
    unwrap(await chat.write(owner.shopId, asked.token, { body: 'hello?' }));
    expect(await replies.handle((await latest()).event)).toBeNull();

    // A conversation given to staff, or answered by them, is theirs too.
    answer = { reply: 'Ji.', hand_off: false };
    const given = await chatOf('kya COD hai?');
    await admin.query(
      'UPDATE messaging.conversations SET assignee_id = $2, assigned_at = now() WHERE id = $1',
      [given.conversationId, newId()],
    );
    expect(await replies.handle(given.event)).toBeNull();
    const answered = await chatOf('size chart?');
    unwrap(await new ConversationsService(database).reply(owner, answered.conversationId, 'Ji'));
    unwrap(await chat.write(owner.shopId, answered.token, { body: 'shukriya, aur?' }));
    expect(await replies.handle((await latest()).event)).toBeNull();
  });

  it('answers no one without a credit left, and keeps why', async () => {
    credits.left = 0;
    const asked = await chatOf('delivery kitne din mein?');
    expect(await replies.handle(asked.event)).toBe('refused');
    expect(await outbound(asked.conversationId)).toEqual([]);
    const { rows } = await admin.query<{ outcome: string }>(
      'SELECT outcome FROM messaging.support_agent_replies WHERE conversation_id = $1',
      [asked.conversationId],
    );
    expect(rows).toEqual([{ outcome: 'refused' }]);
    credits.left = 10;
  });
});
