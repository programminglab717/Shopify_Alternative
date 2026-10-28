import 'reflect-metadata';
import { AiGateway, type SpeechResult } from '@hatti/ai';
import { StorefrontSite, type MutationResult, type TenantContext } from '@hatti/api';
import { AiCreditsService } from '@hatti/billing/public';
import { ProductService } from '@hatti/catalog/public';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import type { DomainEvent } from '@hatti/events';
import { newId } from '@hatti/ids';
import {
  MessagingEvents,
  SupportAgentService,
  VoiceOrderService,
  type MediaResult,
} from '@hatti/messaging/public';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { VoiceOrders, variantAskedFor, voiceOrderReply } from './voice-orders.js';

const server = testDatabaseServer();

function unwrap<T>(result: MutationResult<T> | null): T {
  if (!result?.ok) throw new Error(JSON.stringify(result));
  return result.value;
}

const variant = (id: string, values: string[]) => ({
  id,
  title: values.join(' / '),
  selectedOptions: values.map((value, index) => ({
    name: `Option ${index + 1}`,
    value,
    optionId: `o${index}`,
    valueId: `${id}-${index}`,
  })),
});

describe("A voice note's order, matched to what the shop sells (MSG-11, ADR-871)", () => {
  it('takes the variant whose every value was said, sizes as customers say them', () => {
    const suit = {
      variants: [variant('s-maroon', ['S', 'Maroon']), variant('m-maroon', ['M', 'Maroon'])],
    } as never;
    expect(variantAskedFor(suit, ['medium', 'maroon'])?.id).toBe('m-maroon');
    expect(variantAskedFor(suit, ['Maroon', 'size S'])?.id).toBe('s-maroon');
    // Not enough said to tell: none.
    expect(variantAskedFor(suit, ['maroon'])).toBeNull();
    // A product of one variant needs nothing said.
    expect(
      variantAskedFor({ variants: [variant('only', ['Default Title'])] } as never, [])?.id,
    ).toBe('only');
  });

  it('answers in both languages: the checkout, what to choose, and what was not found', () => {
    const reply = voiceOrderReply(
      {
        lines: [{ variantId: 'v', quantity: 2, name: 'Lawn Suit (M)' }],
        choose: [{ name: 'Khussa', url: 'https://zari.hatti.pk/products/khussa' }],
        missing: ['dupatta'],
      },
      'https://zari.hatti.pk/cart/v:2',
    );
    expect(reply).toContain('2 × Lawn Suit (M)');
    expect(reply).toContain('place your order here: https://zari.hatti.pk/cart/v:2');
    expect(reply).toContain('یہاں آرڈر کریں: https://zari.hatti.pk/cart/v:2');
    expect(reply).toContain('Khussa: https://zari.hatti.pk/products/khussa');
    expect(reply).toContain("We couldn't find dupatta.");
  });
});

describe.skipIf(!server)(
  "Customers' voice notes, heard and answered with an order (MSG-11)",
  () => {
    let testDb: TestDatabase;
    let database: Database;
    let admin: pg.Client;
    const shopId = newId();
    const owner: TenantContext = {
      shopId,
      currency: 'PKR',
      actor: { kind: 'app', tokenId: newId() },
      scopes: new Set(['write_products', 'write_settings']),
    };
    const sent: { conversationId: string; body: string; ai: boolean }[] = [];
    const fetched: { via: string | null; mediaId: string }[] = [];
    const heard: SpeechResult[] = [];
    const answers: unknown[] = [];
    let orders: VoiceOrders;
    let suitM = '';

    /** Each voice note's customer, a number of their own. */
    let customers = 0;

    /** A voice note the customer sent on WhatsApp, kept in the inbox: the event saying so. */
    async function voiceNoteSent(): Promise<DomainEvent & { messageId: string }> {
      const conversationId = newId();
      const messageId = newId();
      customers += 1;
      await admin.query(
        `INSERT INTO messaging.conversations (shop_id, id, customer_phone, last_message_at)
       VALUES ($1, $2, $3, now())`,
        [shopId, conversationId, `+9230045${String(customers).padStart(5, '0')}`],
      );
      await admin.query(
        `INSERT INTO messaging.conversation_messages
              (shop_id, id, conversation_id, direction, media_kind, media_id, at)
       VALUES ($1, $2, $3, 'inbound', 'audio', $4, now())`,
        [shopId, messageId, conversationId, `media-${customers}`],
      );
      return {
        id: newId(),
        type: MessagingEvents.ConversationMessageReceived,
        shopId,
        aggregateType: 'conversation',
        aggregateId: conversationId,
        payload: { messageId, at: new Date().toISOString(), startedWaiting: true },
        messageId,
      } as unknown as DomainEvent & { messageId: string };
    }

    const reading = (input: object) => ({
      content: [{ type: 'tool_use', name: 'give_order', input }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 300, output_tokens: 50 },
    });

    beforeAll(async () => {
      testDb = await createTestDatabase(server!);
      database = new Database({ appUrl: testDb.appUrl, applicationName: 'voice-orders-test' });
      admin = new pg.Client({ connectionString: testDb.adminUrl });
      await admin.connect();
      await admin.query(
        `INSERT INTO control.shops (id, name, handle) VALUES ($1, 'Zari', 'zari')`,
        [shopId],
      );
      const products = new ProductService(database);
      const suit = unwrap(
        await products.create(owner, {
          title: 'Lawn Suit',
          status: 'active',
          options: [{ name: 'Size', values: ['S', 'M'] }],
          variants: [
            { optionValues: ['S'], price: '3,000' },
            { optionValues: ['M'], price: '3,000' },
          ],
        }),
      );
      suitM = suit.variants.find((each) => each.title === 'M')!.id;
      unwrap(
        await products.create(owner, {
          title: 'Khussa',
          status: 'active',
          options: [{ name: 'Size', values: ['6', '7'] }],
          variants: [
            { optionValues: ['6'], price: '2,000' },
            { optionValues: ['7'], price: '2,000' },
          ],
        }),
      );
      const fetch = (async () =>
        new Response(JSON.stringify(answers.shift()), {
          status: 200,
        })) as unknown as typeof globalThis.fetch;
      orders = new VoiceOrders(
        database,
        products,
        {
          mediaOf: async (_shop, via, mediaId): Promise<MediaResult> => {
            fetched.push({ via, mediaId });
            return { ok: true, data: Buffer.from('OggS'), mediaType: 'audio/ogg' };
          },
          reply: async (_tenant, conversationId, body, _now, options) => {
            sent.push({ conversationId, body, ai: options?.ai ?? false });
            return { ok: true, value: {} as never };
          },
        },
        { transcribe: async () => heard.shift() ?? { ok: true, text: '' } },
        new AiGateway({ apiKey: 'test', model: 'model-from-config', fetch }),
        new AiCreditsService(database),
        new StorefrontSite('https://hatti.pk'),
      );
    });

    afterAll(async () => {
      await database?.close();
      await admin?.end();
      await testDb?.drop();
    });

    it('leaves voice notes to staff until the shop turns it on', async () => {
      const note = await voiceNoteSent();
      expect(await orders.handle(note)).toBeNull();
      expect(fetched).toEqual([]);
    });

    it('hears a voice note once, keeps its words, and answers with the checkout holding it', async () => {
      const settings = new VoiceOrderService(database, true);
      expect(await settings.set(owner, true)).toMatchObject({ enabled: true, available: true });
      const note = await voiceNoteSent();
      heard.push({ ok: true, text: 'do lawn suit medium, aik khussa, aur aik dupatta' });
      answers.push(
        reading({
          order: true,
          items: [
            { search: 'lawn suit', quantity: 2, options: ['medium'] },
            { search: 'khussa', quantity: 1 },
            { search: 'dupatta', quantity: 1 },
          ],
        }),
      );
      expect(await orders.handle(note)).toBe('answered');
      expect(fetched.at(-1)).toEqual({ via: null, mediaId: `media-${customers}` });
      const phone = `+9230045${String(customers).padStart(5, '0')}`;
      const [reply] = sent;
      expect(reply).toMatchObject({ conversationId: note.aggregateId, ai: true });
      expect(reply!.body).toContain(
        `https://zari.hatti.pk/cart/${suitM}:2?checkout%5Bphone%5D=${encodeURIComponent(phone)}`,
      );
      expect(reply!.body).toContain('2 × Lawn Suit (M)');
      expect(reply!.body).toContain('Khussa: https://zari.hatti.pk/products/khussa');
      expect(reply!.body).toContain("We couldn't find dupatta.");
      // Its words kept for staff; the credit spent; what came of it kept, never the audio.
      const kept = await admin.query(
        'SELECT transcript, voice_claimed_at IS NOT NULL AS claimed FROM messaging.conversation_messages WHERE id = $1',
        [note.messageId],
      );
      expect(kept.rows).toEqual([
        { transcript: 'do lawn suit medium, aik khussa, aur aik dupatta', claimed: true },
      ]);
      const spent = await admin.query(
        `SELECT count(*)::int AS n FROM billing.ai_credit_uses WHERE shop_id = $1 AND use = 'voice_order'`,
        [shopId],
      );
      expect(spent.rows[0].n).toBe(1);
      const outcome = await admin.query(
        'SELECT outcome, items, matched FROM messaging.voice_orders WHERE message_id = $1',
        [note.messageId],
      );
      expect(outcome.rows).toEqual([{ outcome: 'answered', items: 3, matched: 1 }]);
      expect((await settings.setting(owner)).usedToday).toBe(1);
      // Heard again, it is not heard twice.
      expect(await orders.handle(note)).toBeNull();
      expect(sent).toHaveLength(1);
    });

    it('answers nothing to a voice note that orders nothing, nor one not heard', async () => {
      heard.push({ ok: true, text: 'delivery kab tak hogi?' });
      answers.push(reading({ order: false }));
      expect(await orders.handle(await voiceNoteSent())).toBe('no_order');
      heard.push({ ok: false, reason: 'failed', detail: '500: busy' });
      expect(await orders.handle(await voiceNoteSent())).toBe('not_heard');
      expect(sent).toHaveLength(1);
      expect(answers).toEqual([]);
    });

    it('is left by the AI support agent, where the shop takes orders by voice note', async () => {
      const agent = new SupportAgentService(database);
      unwrap(await agent.update(owner, { enabled: true }));
      const note = await voiceNoteSent();
      expect(await agent.taskOf(shopId, note.aggregateId, note.messageId)).toBeNull();
      unwrap(await agent.update(owner, { enabled: false }));
    });
  },
);
