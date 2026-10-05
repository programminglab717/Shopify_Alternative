import 'reflect-metadata';
import { testDatabaseServer } from '@hatti/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SignUpService } from './sign-ups.js';
import { customersFixture, unwrap, type CustomersFixture } from './test-support.js';

const server = testDatabaseServer();

describe.skipIf(!server)("Sign-ups through the online store's form (CUS-04, ADR-189)", () => {
  let f: CustomersFixture;
  let signUps: SignUpService;

  beforeAll(async () => {
    f = await customersFixture(server!);
    signUps = new SignUpService(f.db);
  });

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
  });

  /** The consent ledger, oldest first. */
  const ledger = async () =>
    (
      await f.admin.query<Record<string, unknown>>(
        `SELECT customer_id, channel, state, source, wording, contact, actor_kind
           FROM customers.consent_events ORDER BY created_at, id`,
      )
    ).rows;

  it('subscribes the number on WhatsApp, made a customer if it is new, in the words the form showed', async () => {
    expect(await signUps.signUp(f.a.shopId, { phone: '0300-1234567', tags: 'newsletter' })).toEqual(
      { ok: true, created: true, subscribed: true },
    );
    const [customer] = (await f.customers.list(f.a, { first: 10 })).items;
    expect(customer).toMatchObject({
      phone: '+923001234567',
      name: null,
      tags: ['newsletter'],
      consent: { whatsapp: { state: 'subscribed' }, sms: { state: 'not_subscribed' } },
    });
    // The platform's words, naming the shop, where the form gave none.
    expect(await ledger()).toEqual([
      {
        customer_id: customer!.id,
        channel: 'whatsapp',
        state: 'subscribed',
        source: 'storefront',
        wording:
          'Send me news and offers from A on WhatsApp\nمجھے A کی خبریں اور آفرز واٹس ایپ پر بھیجیں',
        contact: '+923001234567',
        actor_kind: 'system',
      },
    ]);
    expect(
      (await f.outbox()).map((event) => [event.event_type, event.payload.source ?? null]),
    ).toEqual([
      ['customer.created', 'storefront'],
      ['customer.marketing_consent_updated', 'storefront'],
      // The form's tag.
      ['customer.updated', null],
    ]);

    // Again: nothing changes, the tag kept once whatever its case.
    expect(
      await signUps.signUp(f.a.shopId, { phone: '+92 300 1234567', tags: 'Newsletter, VIP' }),
    ).toEqual({ ok: true, created: false, subscribed: false });
    expect((await f.customers.list(f.a, { first: 10 })).items[0]!.tags).toEqual([
      'newsletter',
      'VIP',
    ]);
    expect(await ledger()).toHaveLength(1);
    // Another shop's customers are its own.
    expect((await f.customers.list(f.b, { first: 10 })).items).toEqual([]);
  });

  it("keeps the form's own words, subscribes again who said no, and leaves another number of theirs", async () => {
    const customer = unwrap(
      await f.customers.create(f.a, {
        phone: '0300 1234567',
        otherPhones: ['0333 5551234'],
        name: 'Ayesha',
        marketingConsent: [{ channel: 'whatsapp', state: 'unsubscribed' }],
      }),
    );
    // Another of their numbers: the shop's messages go to the main one, so nothing is kept.
    expect(await signUps.signUp(f.a.shopId, { phone: '0333 5551234' })).toEqual({
      ok: true,
      created: false,
      subscribed: false,
    });
    expect(
      await signUps.signUp(f.a.shopId, {
        phone: '0300 1234567',
        consent: 'Get our Eid offers on WhatsApp',
      }),
    ).toMatchObject({ ok: true, subscribed: true });
    expect((await ledger()).map((entry) => [entry.state, entry.source, entry.wording])).toEqual([
      // Staff's app recorded the no.
      ['unsubscribed', 'api', null],
      ['subscribed', 'storefront', 'Get our Eid offers on WhatsApp'],
    ]);
    expect((await f.customers.get(f.a, customer.id))!.name).toBe('Ayesha');
  });

  it('says what is wrong with a number, too many tags or words too long', async () => {
    const refused = await signUps.signUp(f.a.shopId, {
      phone: '12345',
      tags: 'a,b,c,d,e,f',
      consent: 'x'.repeat(1_001),
    });
    expect(refused.ok ? [] : refused.errors.map((error) => [error.field, error.code])).toEqual([
      [['phone'], 'INVALID'],
      [['tags'], 'TOO_MANY'],
      [['consent'], 'TOO_LONG'],
    ]);
    expect(await signUps.signUp(f.a.shopId, {})).toMatchObject({
      ok: false,
      errors: [{ field: ['phone'], code: 'BLANK' }],
    });
    expect((await f.customers.list(f.a, { first: 10 })).items).toEqual([]);
  });
});
