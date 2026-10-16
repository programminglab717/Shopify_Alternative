import 'reflect-metadata';
import { testDatabaseServer } from '@hatti/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseAction } from './cart-lines.js';
import { checkoutPage } from './checkout-pages.js';
import type { CheckoutForm, CheckoutView } from './checkout.service.js';
import { checkoutFixture, unwrap, type CheckoutFixture } from './test-support.js';

const server = testDatabaseServer();

describe.skipIf(!server)(
  'Returning shoppers’ saved addresses at checkout (CHK-03, ADR-447)',
  () => {
    let f: CheckoutFixture;
    let kurta: string;

    beforeAll(async () => {
      f = await checkoutFixture(server!);
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
      email: 'ayesha@example.com',
      city: 'Lahore',
      address1: 'House 12, Street 4',
      address2: 'Gulberg',
      landmark: 'near Jamia Masjid',
      province: '',
      payment: '',
      code: '',
      resend: '',
    };

    /** A checkout of a kurta: its secret and what its page showed. */
    async function checkout() {
      const action = parseAction('add', { items: [{ variantId: kurta, quantity: 1 }] });
      if ('code' in action) throw new Error(`Refused: ${JSON.stringify(action)}`);
      const added = await f.carts.act(f.a.shopId, null, action);
      if (!added.ok) throw new Error(`Refused: ${JSON.stringify(added.error)}`);
      const secret = (await f.checkouts.start(f.a.shopId, added.token!))!;
      const view = await f.checkouts.view(secret);
      if (view.kind !== 'open') throw new Error(`Expected an open checkout, got ${view.kind}`);
      return { secret, shown: view.shown };
    }

    const open = (view: CheckoutView) => {
      if (view.kind !== 'open') throw new Error(`Expected an open checkout, got ${view.kind}`);
      return view;
    };

    /** The codes sent, the newest last, as their messages hold them until they are sent. */
    const sent = async () =>
      (
        await f.admin.query<{ channel: string; recipient: string; code: string }>(
          `SELECT channel, recipient, variables ->> 'code' AS code FROM messaging.messages
          WHERE kind = 'one_time_code' ORDER BY created_at, id`,
        )
      ).rows;

    const ask = (secret: string, phone: string, code: string | null = null, channel = 'whatsapp') =>
      f.checkouts.recall(secret, { phone, code, channel: channel as 'whatsapp' | 'sms' });

    it('fills in the last address a proved number ordered to, and spares it a code at placing', async () => {
      unwrap(await f.codRules.update(f.a, { verifyFromScore: 0 }));
      // The first order, its number proved by a code: the browser is given its proof.
      const first = await checkout();
      await f.checkouts.place(first.secret, first.shown, FORM);
      const [firstCode] = await sent();
      const placed = await f.checkouts.place(first.secret, first.shown, {
        ...FORM,
        code: firstCode!.code,
      });
      if (placed.kind !== 'placed') throw new Error(`Expected it placed, got ${placed.kind}`);

      // Back in another browser: the number asked for, a code sent to it.
      const second = await checkout();
      const asked = open(await ask(second.secret, '0300 1234567'));
      expect(asked.problem).toEqual({
        kind: 'recall',
        phone: '0300 ••••567',
        channel: 'whatsapp',
        state: 'sent',
      });
      expect(asked.form.name).toBe('');
      const page = checkoutPage(asked);
      expect(page.status).toBe(200);
      expect(page.html).toContain('name="action" value="recall_code"');
      expect(page.html).toContain('id="recall-code"');
      expect(page.html).toContain('Type the code we sent on WhatsApp to 0300 ••••567.');
      const code = (await sent())[1]!;
      expect(code.recipient).toBe('+923001234567');

      const wrong = String((Number(code.code) + 1) % 10 ** 6).padStart(6, '0');
      const refused = open(await ask(second.secret, '0300 1234567', wrong));
      expect(refused.problem).toMatchObject({ kind: 'recall', state: 'wrong' });
      expect(checkoutPage(refused).status).toBe(422);

      const filled = open(await ask(second.secret, '0300 1234567', code.code));
      expect(filled.problem).toMatchObject({ kind: 'recall', state: 'filled' });
      expect(filled.form).toMatchObject({
        name: 'Ayesha Khan',
        phone: '0300 1234567',
        email: 'ayesha@example.com',
        city: 'Lahore',
        address1: 'House 12, Street 4',
        address2: 'Gulberg',
        landmark: 'near Jamia Masjid',
        province: 'PB',
      });
      const filledPage = checkoutPage(filled);
      expect(filledPage.status).toBe(200);
      expect(filledPage.html).toContain('We filled in the address of your last order.');
      expect(filledPage.html).toContain('value="House 12, Street 4"');
      expect(filledPage.html).not.toContain('value="recall');

      // Placed as filled in: the code proved counts, and no other is sent.
      const again = await f.checkouts.place(second.secret, filled.shown, filled.form);
      expect(again.kind).toBe('placed');
      expect(await sent()).toHaveLength(2);

      // The first browser, which proved the number lately, is filled in at once.
      const third = await checkout();
      const spared = open(
        await f.checkouts.recall(
          third.secret,
          { phone: '03001234567', code: null, channel: 'whatsapp' },
          { client: { ip: null, userAgent: null, proof: placed.proof! } },
        ),
      );
      expect(spared.problem).toMatchObject({ kind: 'recall', state: 'filled' });
      expect(spared.form.address1).toBe('House 12, Street 4');
      expect(await sent()).toHaveLength(2);
    });

    it('answers a number that never ordered as any other, and says so only once it is proved', async () => {
      const { secret } = await checkout();
      const invalid = open(await ask(secret, '12345'));
      expect(invalid.problem).toEqual({
        kind: 'recall',
        phone: '',
        channel: 'whatsapp',
        state: 'invalid',
      });
      const invalidPage = checkoutPage(invalid);
      expect(invalidPage.status).toBe(422);
      expect(invalidPage.html).toContain('Type a Pakistani mobile number');
      expect(await sent()).toEqual([]);

      // A code by SMS, as to a number that ordered before.
      const asked = open(await ask(secret, '0321 7654321', null, 'sms'));
      expect(asked.problem).toEqual({
        kind: 'recall',
        phone: '0321 ••••321',
        channel: 'sms',
        state: 'sent',
      });
      const [code] = await sent();
      expect(code).toMatchObject({ channel: 'sms', recipient: '+923217654321' });

      const proved = open(await ask(secret, '0321 7654321', code!.code));
      expect(proved.problem).toMatchObject({ kind: 'recall', state: 'nothing' });
      expect(proved.form).toMatchObject({ name: '', phone: '0321 7654321', address1: '' });
      const page = checkoutPage(proved);
      expect(page.status).toBe(200);
      expect(page.html).toContain('We have no address for 0321 ••••321 yet.');
    });
  },
);
