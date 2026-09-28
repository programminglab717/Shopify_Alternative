import 'reflect-metadata';
import { pgError } from '@hatti/db';
import { testDatabaseServer } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { toCustomer } from './graphql/mappers.js';
import { customersFixture, errorsOf, unwrap, type CustomersFixture } from './test-support.js';

const server = testDatabaseServer();

const WHATSAPP_OFFERS = 'Send me offers and new arrivals on WhatsApp';

describe.skipIf(!server)('Marketing consent', () => {
  let f: CustomersFixture;

  beforeAll(async () => {
    f = await customersFixture(server!);
  });

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
  });

  async function history(customerId: string) {
    return (await f.customers.consentHistory(f.a, customerId, { first: 50 })).items;
  }

  it('records consent per channel: what, where, when and who', async () => {
    const customer = unwrap(await f.customers.create(f.a, { phone: '03001234567' }));
    expect(customer.consent).toEqual({
      whatsapp: { state: 'not_subscribed', consentedAt: null },
      sms: { state: 'not_subscribed', consentedAt: null },
      email: { state: 'not_subscribed', consentedAt: null },
    });
    await f.admin.query('DELETE FROM platform.outbox_events');

    const updated = unwrap(
      await f.customers.updateMarketingConsent(f.staff, customer.id, [
        { channel: 'whatsapp', state: 'subscribed', wording: ` ${WHATSAPP_OFFERS} ` },
        { channel: 'sms', state: 'unsubscribed' },
      ]),
    );
    expect(updated).toMatchObject({
      version: 2,
      consent: {
        whatsapp: { state: 'subscribed' },
        sms: { state: 'unsubscribed' },
        email: { state: 'not_subscribed', consentedAt: null },
      },
    });
    expect(updated.consent.whatsapp.consentedAt).toBeInstanceOf(Date);
    expect(toCustomer(updated)).toMatchObject({
      whatsappMarketingConsent: { marketingState: 'SUBSCRIBED' },
      smsMarketingConsent: { marketingState: 'UNSUBSCRIBED' },
    });

    const entries = await history(customer.id);
    expect(entries).toMatchObject([
      { channel: 'sms', state: 'unsubscribed', source: 'manual', wording: null },
      {
        channel: 'whatsapp',
        state: 'subscribed',
        source: 'manual',
        wording: WHATSAPP_OFFERS,
        contact: '+923001234567',
        actorKind: 'staff',
      },
    ]);
    expect(f.staff.actor.kind === 'staff' && entries[1]!.actorId).toBe(
      f.staff.actor.kind === 'staff' && f.staff.actor.userId,
    );
    // The customer's time and the ledger's are the same moment.
    expect(entries[1]!.collectedAt).toEqual(updated.consent.whatsapp.consentedAt);
    expect((await f.outbox()).map((event) => [event.event_type, event.payload])).toEqual([
      [
        'customer.marketing_consent_updated',
        { channel: 'whatsapp', state: 'subscribed', source: 'manual', version: 2 },
      ],
      [
        'customer.marketing_consent_updated',
        { channel: 'sms', state: 'unsubscribed', source: 'manual', version: 2 },
      ],
    ]);

    // Asking for the state a channel already has changes nothing.
    const same = unwrap(
      await f.customers.updateMarketingConsent(f.a, customer.id, [
        { channel: 'whatsapp', state: 'subscribed', wording: 'Again' },
      ]),
    );
    expect(same.version).toBe(2);
    expect(await history(customer.id)).toHaveLength(2);

    // An app records it as the API unless it says where the customer said so.
    const imported = new Date('2026-03-01T10:00:00Z');
    const back = unwrap(
      await f.customers.updateMarketingConsent(f.a, customer.id, [
        {
          channel: 'sms',
          state: 'subscribed',
          wording: 'Yes to SMS',
          source: 'import',
          collectedAt: imported,
        },
        { channel: 'whatsapp', state: 'unsubscribed', wording: 'STOP' },
      ]),
    );
    expect(back.consent.sms).toEqual({ state: 'subscribed', consentedAt: imported });
    expect((await history(customer.id)).slice(0, 2)).toMatchObject([
      {
        channel: 'whatsapp',
        state: 'unsubscribed',
        source: 'api',
        wording: 'STOP',
        actorKind: 'app',
      },
      { channel: 'sms', state: 'subscribed', source: 'import', collectedAt: imported },
    ]);
  });

  it('checks what it is told', async () => {
    const customer = unwrap(await f.customers.create(f.a, { phone: '03001234567' }));
    const bad = await f.customers.updateMarketingConsent(f.a, customer.id, [
      { channel: 'whatsapp', state: 'subscribed' },
      { channel: 'sms', state: 'not_subscribed' },
      { channel: 'whatsapp', state: 'unsubscribed' },
      { channel: 'email', state: 'unsubscribed', source: 'contact_changed' },
    ]);
    expect(errorsOf(bad)).toEqual([
      ['marketingConsent.0.wording', 'BLANK'],
      ['marketingConsent.1.state', 'INVALID'],
      ['marketingConsent.2', 'INVALID'],
      ['marketingConsent.3.source', 'INVALID'],
    ]);
    const future = new Date(Date.now() + 86_400_000);
    expect(
      errorsOf(
        await f.customers.updateMarketingConsent(f.a, customer.id, [
          { channel: 'sms', state: 'subscribed', wording: 'Yes', collectedAt: future },
        ]),
      ),
    ).toEqual([['marketingConsent.0.collectedAt', 'INVALID']]);
    // Email consent needs an email address.
    const noEmail = await f.customers.updateMarketingConsent(f.a, customer.id, [
      { channel: 'email', state: 'subscribed', wording: 'Email me' },
    ]);
    expect(noEmail).toEqual({
      ok: false,
      errors: [
        {
          field: ['marketingConsent', '0'],
          code: 'INVALID',
          message: 'Add an email address before recording email consent',
        },
      ],
    });
    expect(
      errorsOf(
        await f.customers.updateMarketingConsent(f.a, newId(), [
          { channel: 'sms', state: 'unsubscribed' },
        ]),
      ),
    ).toEqual([['id', 'NOT_FOUND']]);
    // Another shop can't record consent for this customer, nor read its ledger.
    expect(
      errorsOf(
        await f.customers.updateMarketingConsent(f.b, customer.id, [
          { channel: 'sms', state: 'unsubscribed' },
        ]),
      ),
    ).toEqual([['id', 'NOT_FOUND']]);
    unwrap(
      await f.customers.updateMarketingConsent(f.a, customer.id, [
        { channel: 'sms', state: 'unsubscribed' },
      ]),
    );
    expect((await f.customers.consentHistory(f.b, customer.id, { first: 10 })).items).toEqual([]);
  });

  it('starts again when the number or email it was given for changes', async () => {
    const customer = unwrap(
      await f.customers.create(f.a, {
        phone: '03001234567',
        email: 'ayesha@example.com',
        marketingConsent: [
          { channel: 'whatsapp', state: 'subscribed', wording: WHATSAPP_OFFERS },
          { channel: 'sms', state: 'unsubscribed' },
          { channel: 'email', state: 'subscribed', wording: 'Email me offers' },
        ],
      }),
    );
    expect(customer).toMatchObject({
      version: 1,
      consent: {
        whatsapp: { state: 'subscribed' },
        sms: { state: 'unsubscribed' },
        email: { state: 'subscribed' },
      },
    });

    const renumbered = unwrap(
      await f.customers.update(f.a, customer.id, { phone: '0321 7654321' }),
    );
    expect(renumbered).toMatchObject({
      version: 2,
      consent: {
        whatsapp: { state: 'not_subscribed' },
        sms: { state: 'not_subscribed' },
        email: { state: 'subscribed' },
      },
    });
    expect((await history(customer.id)).slice(0, 2)).toMatchObject([
      {
        channel: 'sms',
        state: 'not_subscribed',
        source: 'contact_changed',
        contact: '+923217654321',
      },
      {
        channel: 'whatsapp',
        state: 'not_subscribed',
        source: 'contact_changed',
        contact: '+923217654321',
      },
    ]);

    // A new email starts email consent again; so does removing it.
    const readdressed = unwrap(
      await f.customers.update(f.a, customer.id, { email: 'ayesha.khan@example.com' }),
    );
    expect(readdressed.consent.email.state).toBe('not_subscribed');
    unwrap(
      await f.customers.updateMarketingConsent(f.a, customer.id, [
        { channel: 'email', state: 'subscribed', wording: 'Email me offers' },
      ]),
    );
    const removed = unwrap(await f.customers.update(f.a, customer.id, { email: null }));
    expect(removed).toMatchObject({ email: null, consent: { email: { state: 'not_subscribed' } } });
    expect((await history(customer.id))[0]).toMatchObject({
      channel: 'email',
      state: 'not_subscribed',
      source: 'contact_changed',
      contact: 'ayesha.khan@example.com',
    });

    // Changing only the name leaves consent alone.
    const renamed = unwrap(await f.customers.update(f.a, customer.id, { name: 'Ayesha' }));
    expect(renamed.consent).toEqual(removed.consent);
  });

  it('keeps the ledger append-only', async () => {
    const customer = unwrap(
      await f.customers.create(f.a, {
        phone: '03001234567',
        marketingConsent: [{ channel: 'sms', state: 'subscribed', wording: 'Yes to SMS' }],
      }),
    );
    for (const statement of [
      sql`UPDATE customers.consent_events SET wording = 'Something else'`,
      sql`DELETE FROM customers.consent_events`,
    ]) {
      const error = await f.db
        .tenant(f.a.shopId, (tx) => tx.execute(statement))
        .catch((caught: unknown) => caught);
      expect(pgError(error)?.code).toBe('42501');
    }
    expect(await history(customer.id)).toMatchObject([{ wording: 'Yes to SMS' }]);
  });

  it('lets segments find who agreed to what', async () => {
    const yes = unwrap(
      await f.customers.create(f.a, {
        phone: '03001234567',
        marketingConsent: [{ channel: 'whatsapp', state: 'subscribed', wording: WHATSAPP_OFFERS }],
      }),
    );
    const no = unwrap(
      await f.customers.create(f.a, {
        phone: '03217654321',
        marketingConsent: [{ channel: 'whatsapp', state: 'unsubscribed' }],
      }),
    );
    const never = unwrap(await f.customers.create(f.a, { phone: '03335551234' }));
    const ids = async (query: string) =>
      (await f.segments.members(f.a, query, { first: 10 })).items.map((item) => item.id);

    expect(await ids('whatsapp_subscription_status = subscribed')).toEqual([yes.id]);
    expect(await ids('whatsapp_subscription_status = UNSUBSCRIBED')).toEqual([no.id]);
    expect(await ids('whatsapp_subscription_status != subscribed')).toEqual([never.id, no.id]);
    expect(await ids('sms_subscription_status = not_subscribed')).toEqual([
      never.id,
      no.id,
      yes.id,
    ]);
    await expect(f.segments.count(f.a, 'email_subscription_status = maybe')).rejects.toThrow(
      '"maybe" is not subscribed, not_subscribed or unsubscribed',
    );
  });
});
