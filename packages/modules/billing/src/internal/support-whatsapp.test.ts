import 'reflect-metadata';
import { randomInt } from 'node:crypto';
import type { TenantContext } from '@hatti/api';
import { testDatabaseServer } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import type { InboundMessage } from '@hatti/messaging/public';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SUPPORT_LIMITS, SupportService } from './support.service.js';
import type { SupportWhatsAppSender } from './support-whatsapp.js';
import { billingFixture, unwrap, type BillingFixture } from './test-support.js';

const server = testDatabaseServer();

const SUPPORT_LINE = '300000000000003';
const year = { start: new Date('2026-10-01'), end: new Date('2027-10-01') };
const HOUR = 3_600_000;

/** Hatti's support number as tests see it: each answer kept, or refused while `failing`. */
class TestSender implements SupportWhatsAppSender {
  readonly sent: { to: string; text: string }[] = [];
  failing: string | null = null;

  async send(to: string, text: string) {
    if (this.failing) return { ok: false as const, error: this.failing };
    this.sent.push({ to, text });
    return { ok: true as const, id: `wamid.answer${this.sent.length}` };
  }
}

describe.skipIf(!server)("Support requests on Hatti's support WhatsApp (BIL-05, ADR-560)", () => {
  let f: BillingFixture;
  let sender: TestSender;
  let support: SupportService;

  beforeAll(async () => {
    f = await billingFixture(server!);
  });

  beforeEach(async () => {
    await f.reset();
    await f.admin.query('DELETE FROM billing.support_requests');
    sender = new TestSender();
    support = new SupportService(f.db, null, sender);
  });

  afterAll(async () => {
    await f?.close();
  });

  /** A member of staff of `shops`, the first joined first, with the number they proved. */
  async function staff(
    shops: string[],
    options: { language?: 'en' | 'ur'; proved?: boolean } = {},
  ): Promise<{ userId: string; phone: string }> {
    const userId = newId();
    const phone = `+92345${String(randomInt(0, 10_000_000)).padStart(7, '0')}`;
    await f.admin.query(
      `INSERT INTO identity.users (id, name, email, phone_e164, phone_verified_at, language)
       VALUES ($1, 'Omar', $2, $3, CASE WHEN $4 THEN now() END, $5)`,
      [userId, `${userId}@example.pk`, phone, options.proved ?? true, options.language ?? 'en'],
    );
    for (const shopId of shops) {
      await f.admin.query(
        `INSERT INTO identity.memberships (user_id, shop_id, role, created_at)
         VALUES ($1, $2, 'manager', clock_timestamp())`,
        [userId, shopId],
      );
    }
    return { userId, phone };
  }

  /** What `from` wrote to Hatti's support number, as WhatsApp's webhook gives it. */
  const written = (
    from: string,
    text: string | null,
    extra: Partial<InboundMessage> = {},
  ): InboundMessage => ({
    from,
    text,
    replyTo: null,
    payload: null,
    at: new Date(),
    id: `wamid.${newId()}`,
    to: SUPPORT_LINE,
    mediaKind: null,
    ...extra,
  });

  const as = (tenant: TenantContext, userId: string): TenantContext => ({
    ...tenant,
    actor: { ...(tenant.actor as Extract<TenantContext['actor'], { kind: 'staff' }>), userId },
  });

  const messagesOf = async (tenant: TenantContext, requestId: string) =>
    (await support.messagesOf(tenant.shopId, [requestId])).get(requestId)!;

  it('keeps nothing from a number no member of staff proved, nor a message with nothing in it', async () => {
    const unproved = await staff([f.a.shopId], { proved: false });
    const known = await staff([f.a.shopId]);
    expect(await support.recordWhatsApp(written('+923339876543', 'Orders do not book'))).toBe(
      false,
    );
    expect(await support.recordWhatsApp(written(unproved.phone, 'Orders do not book'))).toBe(false);
    expect(await support.recordWhatsApp(written(known.phone, '   '))).toBe(false);
    expect(await support.requests(f.a)).toEqual([]);
  });

  it("opens a request of the member of staff's shop at its plan's priority, and adds what follows to it", async () => {
    await f.subscribe(f.a, 'growth', 'monthly', year);
    const omar = await staff([f.a.shopId]);
    const first = written(omar.phone, 'Orders do not book with PostEx');
    expect(await support.recordWhatsApp(first)).toBe(true);
    const [request] = await support.requests(f.a);
    expect(request).toMatchObject({
      channel: 'whatsapp',
      topic: 'other',
      message: 'Orders do not book with PostEx',
      language: 'en',
      callBack: null,
      priority: 1,
      status: 'open',
    });
    const { rows } = await f.admin.query(
      'SELECT opened_by, whatsapp_from FROM billing.support_requests WHERE id = $1',
      [request!.id],
    );
    expect(rows[0]).toEqual({ opened_by: omar.userId, whatsapp_from: omar.phone });

    // What follows is added to it, a photo too; a message WhatsApp names twice is kept once.
    const later = new Date(first.at.getTime() + 60_000);
    const followUp = written(omar.phone, 'Since this morning', { at: later });
    expect(await support.recordWhatsApp(followUp)).toBe(true);
    expect(await support.recordWhatsApp(followUp)).toBe(true);
    const photo = new Date(later.getTime() + 60_000);
    await support.recordWhatsApp(written(omar.phone, null, { mediaKind: 'image', at: photo }));
    expect(await support.requests(f.a)).toHaveLength(1);
    expect(
      (await messagesOf(f.a, request!.id)).map((each) => [
        each.direction,
        each.body,
        each.mediaKind,
      ]),
    ).toEqual([
      ['inbound', 'Orders do not book with PostEx', null],
      ['inbound', 'Since this morning', null],
      ['inbound', null, 'image'],
    ]);
    // Hatti's people see what they last wrote.
    expect(await support.waiting()).toMatchObject([
      { id: request!.id, channel: 'whatsapp', lastInbound: { text: '[image]', at: photo } },
    ]);
    // The other shop sees none of it.
    expect(await support.requests(f.b)).toEqual([]);
    expect(await messagesOf(f.b, request!.id)).toEqual([]);
  });

  it('takes the language from the script they write in, else their account', async () => {
    const ayesha = await staff([f.a.shopId]);
    await support.recordWhatsApp(written(ayesha.phone, 'آرڈر بک نہیں ہو رہے'));
    const bilal = await staff([f.b.shopId], { language: 'ur' });
    await support.recordWhatsApp(written(bilal.phone, 'Order book nahi ho rahe'));
    const omar = await staff([f.b.shopId]);
    await support.recordWhatsApp(written(omar.phone, 'Orders do not book'));
    expect((await support.requests(f.a)).map((each) => each.language)).toEqual(['ur']);
    expect((await support.requests(f.b)).map((each) => [each.message, each.language])).toEqual([
      ['Orders do not book', 'en'],
      ['Order book nahi ho rahe', 'ur'],
    ]);
  });

  it('opens a request in the shop they last asked in, else the one they joined first', async () => {
    const omar = await staff([f.a.shopId, f.b.shopId]);
    await support.recordWhatsApp(written(omar.phone, 'Where are my invoices?'));
    const [first] = await support.requests(f.a);
    expect(first).toMatchObject({ channel: 'whatsapp' });
    await support.close(f.a, first!.id);

    // A request from the admin, in the other shop: what they write on WhatsApp is added to it.
    const asked = unwrap(
      await support.request(as(f.b, omar.userId), {
        topic: 'couriers',
        message: 'PostEx bookings fail for Multan.',
        language: 'en',
      }),
    );
    await support.recordWhatsApp(written(omar.phone, 'Still failing'));
    expect(await support.requests(f.b)).toMatchObject([{ id: asked.id, channel: 'admin' }]);
    expect((await messagesOf(f.b, asked.id)).map((each) => each.body)).toEqual(['Still failing']);

    // Once it is closed, a new one opens where they last asked.
    await support.close(f.b, asked.id);
    await support.recordWhatsApp(written(omar.phone, 'Another thing'));
    expect((await support.requests(f.b)).map((each) => [each.channel, each.message])).toEqual([
      ['whatsapp', 'Another thing'],
      ['admin', 'PostEx bookings fail for Multan.'],
    ]);
    expect(await support.requests(f.a)).toHaveLength(1);
  });

  it('adds to the newest open request where the shop has as many open as it may', async () => {
    const asker = await staff([f.a.shopId]);
    const ids: string[] = [];
    for (let n = 0; n < SUPPORT_LIMITS.open; n++) {
      const asked = unwrap(
        await support.request(as(f.a, asker.userId), {
          topic: 'orders',
          message: `Request number ${n} from the admin.`,
          language: 'en',
        }),
      );
      ids.push(asked.id);
    }
    const omar = await staff([f.a.shopId]);
    expect(await support.recordWhatsApp(written(omar.phone, 'Help'))).toBe(true);
    expect(await support.requests(f.a)).toHaveLength(SUPPORT_LIMITS.open);
    expect((await messagesOf(f.a, ids.at(-1)!)).map((each) => each.body)).toEqual(['Help']);
  });

  it('sends the answer back on WhatsApp within the day WhatsApp allows, and keeps how it went', async () => {
    const omar = await staff([f.a.shopId]);
    const at = new Date();
    await support.recordWhatsApp(written(omar.phone, 'Orders do not book', { at }));
    const [request] = await support.waiting();
    const answered = unwrap(
      await support.answer(request!.id, 'PostEx fixed it; book again.', 'Ayesha', at),
    );
    expect(answered).toMatchObject({
      status: 'answered',
      answer: 'PostEx fixed it; book again.',
      whatsapp: { kind: 'sent', id: 'wamid.answer1' },
    });
    expect(sender.sent).toEqual([{ to: omar.phone, text: 'PostEx fixed it; book again.' }]);
    expect((await messagesOf(f.a, request!.id)).at(-1)).toMatchObject({
      direction: 'outbound',
      body: 'PostEx fixed it; book again.',
      status: 'sent',
      error: null,
    });

    // Delivered, then read; never back, and failed only before delivery.
    const unknown = { providerMessageId: 'wamid.other', status: 'read' as const, at };
    expect(
      await support.recordStatuses([
        { providerMessageId: 'wamid.answer1', status: 'read', at },
        unknown,
      ]),
    ).toEqual([unknown]);
    await support.recordStatuses([
      { providerMessageId: 'wamid.answer1', status: 'delivered', at },
      { providerMessageId: 'wamid.answer1', status: 'failed', at, error: 'WhatsApp 131026' },
    ]);
    expect((await messagesOf(f.a, request!.id)).at(-1)).toMatchObject({
      status: 'read',
      error: null,
    });
  });

  it('keeps the answer alone once a day passed, or where WhatsApp refuses it', async () => {
    const omar = await staff([f.a.shopId]);
    const at = new Date();
    await support.recordWhatsApp(written(omar.phone, 'Orders do not book', { at }));
    const [late] = await support.waiting();
    expect(
      unwrap(await support.answer(late!.id, 'Fixed.', 'Ayesha', new Date(at.getTime() + 25 * HOUR)))
        .whatsapp,
    ).toEqual({ kind: 'window_closed' });
    expect(sender.sent).toEqual([]);
    expect((await support.requests(f.a))[0]).toMatchObject({
      status: 'answered',
      answer: 'Fixed.',
    });
    expect((await messagesOf(f.a, late!.id)).map((each) => each.direction)).toEqual(['inbound']);

    // A failed send is kept as failed, with why.
    await support.recordWhatsApp(written(omar.phone, 'And payments too', { at }));
    const [failing] = await support.waiting();
    sender.failing = 'WhatsApp 131047: Re-engagement message';
    expect(unwrap(await support.answer(failing!.id, 'Fixed.', 'Ayesha', at)).whatsapp).toEqual({
      kind: 'failed',
      error: 'WhatsApp 131047: Re-engagement message',
    });
    expect((await messagesOf(f.a, failing!.id)).at(-1)).toMatchObject({
      direction: 'outbound',
      status: 'failed',
      error: 'WhatsApp 131047: Re-engagement message',
    });

    // Without the support number set up, it is not sent at all.
    await support.recordWhatsApp(written(omar.phone, 'One more', { at }));
    const [unsent] = await support.waiting();
    const unconfigured = new SupportService(f.db);
    expect(unwrap(await unconfigured.answer(unsent!.id, 'Fixed.', 'Ayesha', at)).whatsapp).toEqual({
      kind: 'unavailable',
    });
  });

  it('leaves a request from the admin as it was', async () => {
    const asked = unwrap(
      await support.request(f.a, {
        topic: 'couriers',
        message: 'PostEx bookings fail for Multan.',
        language: 'en',
      }),
    );
    expect(asked.channel).toBe('admin');
    const answered = unwrap(await support.answer(asked.id, 'Fixed.', 'Ayesha'));
    expect(answered.whatsapp).toEqual({ kind: 'none' });
    expect(answered.lastInbound).toBeNull();
    expect(sender.sent).toEqual([]);
    expect(await messagesOf(f.a, asked.id)).toEqual([]);
  });
});
