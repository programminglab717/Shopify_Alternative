import 'reflect-metadata';
import { CustomerService } from '@hatti/customers/public';
import { testDatabaseServer } from '@hatti/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseAction } from './cart-lines.js';
import { checkoutPage } from './checkout-pages.js';
import type { CheckoutForm } from './checkout.service.js';
import { checkoutFixture, unwrap, type CheckoutFixture } from './test-support.js';

const server = testDatabaseServer();

describe.skipIf(!server)(
  "Consent to the shop's news and offers at checkout (CUS-04, ADR-187)",
  () => {
    let f: CheckoutFixture;
    let kurta: string;
    let customers: CustomerService;

    beforeAll(async () => {
      f = await checkoutFixture(server!);
      customers = new CustomerService(f.db);
    });

    afterAll(async () => {
      await f?.close();
    });

    beforeEach(async () => {
      await f.reset();
      [kurta] = (await f.variantsOf(f.a, 'Kurta', { price: '2,000' })) as [string];
      await f.stock(f.a, kurta, 100);
    });

    const FORM: CheckoutForm = {
      name: 'Ayesha Khan',
      phone: '0300-1234567',
      city: 'Lahore',
      address1: 'House 12, Street 4',
      address2: '',
      landmark: '',
      province: '',
      payment: '',
      code: '',
      resend: '',
    };

    /** A checkout of a kurta: its secret and its page as it opens. */
    async function checkout() {
      const action = parseAction('add', { items: [{ variantId: kurta, quantity: 1 }] });
      if ('code' in action) throw new Error(`Refused: ${JSON.stringify(action)}`);
      const added = await f.carts.act(f.a.shopId, null, action);
      if (!added.ok) throw new Error(`Refused: ${JSON.stringify(added.error)}`);
      const secret = (await f.checkouts.start(f.a.shopId, added.token!))!;
      const view = await f.checkouts.view(secret);
      if (view.kind !== 'open') throw new Error(`Expected an open checkout, got ${view.kind}`);
      return { secret, view };
    }

    /** A checkout of a kurta, placed with `form`. */
    async function place(form: Partial<CheckoutForm>) {
      const { secret, view } = await checkout();
      const placed = await f.checkouts.place(secret, view.shown, { ...FORM, ...form });
      if (placed.kind !== 'placed') throw new Error(`Expected it placed, got ${placed.kind}`);
      return placed.order;
    }

    /** The consent of the customer with main number `phone`, channel by channel. */
    async function consentOf(phone: string) {
      const { rows } = await f.admin.query<Record<string, string>>(
        `SELECT whatsapp_consent AS whatsapp, sms_consent AS sms, email_consent AS email
         FROM customers.customers WHERE phone = $1`,
        [phone],
      );
      return rows[0];
    }

    /** The consent ledger, oldest first. */
    const ledger = async () =>
      (
        await f.admin.query<Record<string, unknown>>(
          `SELECT channel, state, source, wording, contact, actor_kind, actor_id
           FROM customers.consent_events ORDER BY created_at, id`,
        )
      ).rows;

    it("offers WhatsApp until the shop chooses, and keeps a box ticked as the customer's consent, in its words", async () => {
      const { view } = await checkout();
      expect(view.marketing).toEqual(['whatsapp']);
      expect(checkoutPage(view).html).toContain('name="marketingWhatsapp"');

      // Left unticked, nothing is recorded.
      await place({});
      expect(await consentOf('+923001234567')).toEqual({
        whatsapp: 'not_subscribed',
        sms: 'not_subscribed',
        email: 'not_subscribed',
      });
      expect(await ledger()).toEqual([]);

      // Ticked: subscribed from the checkout, by the system, in the page's words.
      await place({ marketing: 'whatsapp' });
      expect(await consentOf('+923001234567')).toMatchObject({ whatsapp: 'subscribed' });
      expect(await ledger()).toEqual([
        {
          channel: 'whatsapp',
          state: 'subscribed',
          source: 'checkout',
          wording:
            'Send me news and offers from A on WhatsApp\nمجھے A کی خبریں اور آفرز واٹس ایپ پر بھیجیں',
          contact: '+923001234567',
          actor_kind: 'system',
          actor_id: null,
        },
      ]);
      expect(
        (await f.outbox())
          .filter((event) => event.event_type === 'customer.marketing_consent_updated')
          .map((event) => event.payload),
      ).toEqual([{ channel: 'whatsapp', state: 'subscribed', source: 'checkout', version: 2 }]);

      // Ticked again, it is as it was.
      await place({ marketing: 'whatsapp' });
      expect(await ledger()).toHaveLength(1);
    });

    it("offers the channels the shop chooses, each kept only for the customer's own number or email", async () => {
      expect(await f.marketing.update(f.a, ['email', 'sms', 'email'])).toMatchObject({
        ok: false,
        errors: [{ field: ['channels', '2'], message: 'The same channel is listed twice' }],
      });
      expect(unwrap(await f.marketing.update(f.a, ['email', 'sms']))).toEqual(['sms', 'email']);
      unwrap(await f.marketing.update(f.a, ['sms', 'email']));
      expect(
        (await f.outbox())
          .filter((event) => event.event_type === 'marketing_options.updated')
          .map((event) => event.payload),
      ).toEqual([{ channels: ['sms', 'email'] }]);
      expect(await f.marketing.get(f.b)).toEqual(['whatsapp']);
      const { view } = await checkout();
      expect(view.marketing).toEqual(['sms', 'email']);

      // A customer staff added, with a second number and no email.
      unwrap(
        await customers.create(f.a, {
          phone: '0300 1234567',
          otherPhones: ['0333 5551234'],
          name: 'Ayesha',
        }),
      );
      const everything = 'whatsapp sms email';
      // Typed with their second number: their messages go to the main one, so nothing is kept;
      // nor is WhatsApp, which the page did not offer.
      await place({ phone: '0333 5551234', email: 'ayesha@example.com', marketing: everything });
      expect(await ledger()).toEqual([]);
      // With their main number: SMS, but not an email that isn't theirs.
      await place({ email: 'ayesha@example.com', marketing: everything });
      expect(await consentOf('+923001234567')).toEqual({
        whatsapp: 'not_subscribed',
        sms: 'subscribed',
        email: 'not_subscribed',
      });
      // A new customer's email is theirs, as typed.
      await place({ phone: '0321 7654321', email: 'Bilal@Example.com', marketing: 'email' });
      expect(await consentOf('+923217654321')).toMatchObject({ email: 'subscribed' });
      expect((await ledger()).map((entry) => [entry.channel, entry.contact])).toEqual([
        ['sms', '+923001234567'],
        ['email', 'bilal@example.com'],
      ]);

      // None offered, none shown.
      unwrap(await f.marketing.update(f.a, []));
      const none = await checkout();
      expect(none.view.marketing).toEqual([]);
      expect(checkoutPage(none.view).html).not.toContain('news and offers');
    });
  },
);
