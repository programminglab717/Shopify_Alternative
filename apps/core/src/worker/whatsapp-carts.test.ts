import 'reflect-metadata';
import { StorefrontSite, type MutationResult, type TenantContext } from '@hatti/api';
import { ProductService, VariantService } from '@hatti/catalog/public';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import type { DomainEvent } from '@hatti/events';
import { newId } from '@hatti/ids';
import {
  MessagingEvents,
  SupportAgentService,
  parseWhatsAppWebhook,
} from '@hatti/messaging/public';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WhatsAppCarts, cartReply } from './whatsapp-carts.js';

const server = testDatabaseServer();

function unwrap<T>(result: MutationResult<T> | null): T {
  if (!result?.ok) throw new Error(JSON.stringify(result));
  return result.value;
}

describe("A cart from WhatsApp's catalogue (CH-02, ADR-856)", () => {
  it('is read from the webhook, each item named and counted', () => {
    const { inbound } = parseWhatsAppWebhook({
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: '1098765' },
                messages: [
                  {
                    from: '923001234567',
                    id: 'wamid.cart',
                    timestamp: '1761640000',
                    type: 'order',
                    order: {
                      catalog_id: '889900',
                      text: 'Jaldi bhej dein',
                      product_items: [
                        {
                          product_retailer_id: 'v-1',
                          quantity: 2,
                          item_price: 2000,
                          currency: 'PKR',
                        },
                        { product_retailer_id: 'v 2<script>', quantity: 1 },
                        { product_retailer_id: 'v-3', quantity: 0 },
                      ],
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(inbound).toEqual([
      expect.objectContaining({
        from: '+923001234567',
        text: 'Jaldi bhej dein',
        mediaKind: 'order',
        cart: [{ variantId: 'v-1', quantity: 2 }],
      }),
    ]);
  });

  it('is answered in both languages, saying what it left out', () => {
    expect(cartReply('https://zari.hatti.pk/cart/a:1', 0)).toBe(
      'Thank you for your order! Check your cart and your address, and place it here: https://zari.hatti.pk/cart/a:1\n\n' +
        'آپ کے آرڈر کا شکریہ! اپنا کارٹ اور پتا دیکھیں اور یہاں آرڈر کریں: https://zari.hatti.pk/cart/a:1',
    );
    expect(cartReply('x', 2)).toContain(
      "2 items aren't sold online any more, so they are left out.",
    );
  });
});

describe.skipIf(!server)("Carts from shops' WhatsApp catalogues, answered (CH-02)", () => {
  let testDb: TestDatabase;
  let database: Database;
  let admin: pg.Client;
  const shopId = newId();
  const owner: TenantContext = {
    shopId,
    currency: 'PKR',
    actor: { kind: 'app', tokenId: newId() },
    scopes: new Set(['write_products']),
  };
  const sent: { conversationId: string; body: string }[] = [];
  let carts: WhatsAppCarts;
  let kurta = '';
  let draft = '';

  /** A cart the customer sent on WhatsApp, kept in the inbox: the event saying so. */
  async function cartSent(items: unknown, note: string | null = null): Promise<DomainEvent> {
    const conversationId = newId();
    const messageId = newId();
    await admin.query(
      `INSERT INTO messaging.conversations (shop_id, id, customer_phone, last_message_at)
       VALUES ($1, $2, $3, now())`,
      [
        shopId,
        conversationId,
        `+9230012${String(sent.length).padStart(5, '0')}${Math.floor(Math.random() * 9)}`,
      ],
    );
    await admin.query(
      `INSERT INTO messaging.conversation_messages
              (shop_id, id, conversation_id, direction, body, media_kind, at, cart)
       VALUES ($1, $2, $3, 'inbound', $5, 'order', now(), $4::jsonb)`,
      [shopId, messageId, conversationId, JSON.stringify(items), note],
    );
    return {
      id: newId(),
      type: MessagingEvents.ConversationMessageReceived,
      shopId,
      aggregateType: 'conversation',
      aggregateId: conversationId,
      payload: { messageId, at: new Date().toISOString(), startedWaiting: true },
    } as unknown as DomainEvent;
  }

  beforeAll(async () => {
    testDb = await createTestDatabase(server!);
    database = new Database({ appUrl: testDb.appUrl, applicationName: 'whatsapp-carts-test' });
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name, handle) VALUES ($1, 'Zari', 'zari')`, [
      shopId,
    ]);
    const products = new ProductService(database);
    kurta = unwrap(
      await products.create(owner, {
        title: 'Kurta',
        status: 'active',
        variants: [{ price: '2,000' }],
      }),
    ).variants[0]!.id;
    draft = unwrap(
      await products.create(owner, {
        title: 'Draft',
        status: 'draft',
        variants: [{ price: '900' }],
      }),
    ).variants[0]!.id;
    carts = new WhatsAppCarts(
      database,
      new VariantService(database),
      {
        reply: async (_tenant, conversationId, body) => {
          sent.push({ conversationId, body });
          return { ok: true, value: {} as never };
        },
      },
      new StorefrontSite('https://hatti.pk'),
    );
  });

  afterAll(async () => {
    await database?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it("answers once with the shop's checkout holding what it sells, the number filled in", async () => {
    const event = await cartSent([
      { variantId: kurta, quantity: 2 },
      { variantId: draft, quantity: 1 },
      { variantId: 'v-gone', quantity: 1 },
    ]);
    const link = await carts.handle(event);
    const phone = (
      await admin.query<{ customer_phone: string }>(
        'SELECT customer_phone FROM messaging.conversations WHERE id = $1',
        [event.aggregateId],
      )
    ).rows[0]!.customer_phone;
    expect(link).toBe(
      `https://zari.hatti.pk/cart/${kurta}:2?checkout%5Bphone%5D=${encodeURIComponent(phone)}`,
    );
    expect(sent.at(-1)).toEqual({
      conversationId: event.aggregateId,
      body: cartReply(link!, 2),
    });
    // Heard again, it is not answered twice.
    expect(await carts.handle(event)).toBeNull();
    expect(sent).toHaveLength(1);
  });

  it('is answered by its checkout, never by the AI, where the shop has the AI answer', async () => {
    const agent = new SupportAgentService(database);
    unwrap(await agent.update(owner, { enabled: true }));
    // With a note beside it, which the AI would otherwise answer.
    const event = await cartSent([{ variantId: kurta, quantity: 1 }], 'Jaldi bhej dein');
    const { messageId } = event.payload as unknown as { messageId: string };
    expect(await agent.taskOf(shopId, event.aggregateId, messageId)).toBeNull();
    unwrap(await agent.update(owner, { enabled: false }));
    expect(await carts.handle(event)).not.toBeNull();
    sent.length = 1;
  });

  it('leaves a cart of nothing the shop sells to its staff', async () => {
    expect(await carts.handle(await cartSent([{ variantId: draft, quantity: 1 }]))).toBeNull();
    expect(sent).toHaveLength(1);
  });
});
