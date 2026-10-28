import 'reflect-metadata';
import { testDatabaseServer } from '@hatti/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseAction } from './cart-lines.js';
import { checkoutPage } from './checkout-pages.js';
import type { CheckoutForm, CheckoutView } from './checkout.service.js';
import { checkoutFixture, type CheckoutFixture } from './test-support.js';
import type { TenantContext } from '@hatti/api';

const server = testDatabaseServer();

describe.skipIf(!server)(
  "Hatti Pass: a shopper's details at any Hatti shop (CUS-08, ADR-867)",
  () => {
    let f: CheckoutFixture;
    const kurtas = new Map<string, string>();

    beforeAll(async () => {
      f = await checkoutFixture(server!);
    });

    afterAll(async () => {
      await f?.close();
    });

    beforeEach(async () => {
      await f.reset();
      for (const shop of [f.a, f.b]) {
        const [kurta] = (await f.variantsOf(shop, 'Kurta', { price: '2,000' })) as [string];
        await f.stock(shop, kurta, 100);
        kurtas.set(shop.shopId, kurta);
      }
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

    async function checkout(shop: TenantContext) {
      const action = parseAction('add', {
        items: [{ variantId: kurtas.get(shop.shopId)!, quantity: 1 }],
      });
      if ('code' in action) throw new Error(`Refused: ${JSON.stringify(action)}`);
      const added = await f.carts.act(shop.shopId, null, action);
      if (!added.ok) throw new Error(`Refused: ${JSON.stringify(added.error)}`);
      const secret = (await f.checkouts.start(shop.shopId, added.token!))!;
      const view = await f.checkouts.view(secret);
      if (view.kind !== 'open') throw new Error(`Expected an open checkout, got ${view.kind}`);
      return { secret, shown: view.shown };
    }

    const open = (view: CheckoutView) => {
      if (view.kind !== 'open') throw new Error(`Expected an open checkout, got ${view.kind}`);
      return view;
    };

    const codes = async () =>
      (
        await f.admin.query<{ code: string }>(
          `SELECT variables ->> 'code' AS code FROM messaging.messages
          WHERE kind = 'one_time_code' ORDER BY created_at, id`,
        )
      ).rows.map((row) => row.code);

    const passes = async () =>
      (
        await f.admin.query<{ phone: string; name: string; address: Record<string, unknown> }>(
          'SELECT phone, name, address FROM platform.hatti_passes ORDER BY phone',
        )
      ).rows;

    it('saves a proved number’s details when asked, fills them in at another shop, and forgets them', async () => {
      // Offered, unticked, on the form.
      const first = await checkout(f.a);
      const page = checkoutPage(open(await f.checkouts.view(first.secret)));
      expect(page.html).toContain('name="hatti_pass" value="1"');
      expect(page.html).not.toContain('name="hatti_pass" value="1" checked');

      // Not ticked: nothing kept, though the order is placed.
      expect((await f.checkouts.place(first.secret, first.shown, FORM)).kind).toBe('placed');
      expect(await passes()).toEqual([]);

      // Ticked: kept once the shopper proves the number with a code, as for store credit.
      const second = await checkout(f.a);
      const asked = open(
        await f.checkouts.place(second.secret, second.shown, { ...FORM, pass: '1' }),
      );
      expect(asked.problem).toMatchObject({ kind: 'code', state: 'sent' });
      expect(await passes()).toEqual([]);
      const [code] = await codes();
      const placed = await f.checkouts.place(second.secret, second.shown, {
        ...FORM,
        pass: '1',
        code: code!,
      });
      expect(placed.kind).toBe('placed');
      expect(await passes()).toEqual([
        {
          phone: '+923001234567',
          name: 'Ayesha Khan',
          address: {
            address1: 'House 12, Street 4',
            address2: 'Gulberg',
            landmark: 'near Jamia Masjid',
            city: 'Lahore',
            provinceCode: 'PB',
            zip: null,
            location: null,
          },
        },
      ]);

      // At another Hatti shop where she never ordered, her proved number fills the form in.
      const elsewhere = await checkout(f.b);
      const sent = open(
        await f.checkouts.recall(elsewhere.secret, {
          phone: '0300 1234567',
          code: null,
          channel: 'whatsapp',
        }),
      );
      expect(sent.problem).toMatchObject({ kind: 'recall', state: 'sent' });
      const filled = open(
        await f.checkouts.recall(elsewhere.secret, {
          phone: '0300 1234567',
          code: (await codes()).at(-1)!,
          channel: 'whatsapp',
        }),
      );
      expect(filled.problem).toMatchObject({ kind: 'recall', state: 'filled_pass' });
      expect(filled.form).toMatchObject({
        name: 'Ayesha Khan',
        email: 'ayesha@example.com',
        city: 'Lahore',
        address1: 'House 12, Street 4',
        address2: 'Gulberg',
        landmark: 'near Jamia Masjid',
        province: 'PB',
      });
      const filledPage = checkoutPage(filled);
      expect(filledPage.html).toContain('We filled in your details from your Hatti Pass.');
      expect(filledPage.html).toContain('name="action" value="pass_forget"');

      // Forgotten from there, as the number is proved in this checkout.
      const forgotten = open(
        await f.checkouts.forgetPass(elsewhere.secret, { phone: '0300 1234567' }),
      );
      expect(forgotten.problem).toMatchObject({ kind: 'recall', state: 'pass_forgotten' });
      expect(checkoutPage(forgotten).html).toContain(
        'is forgotten. No Hatti shop fills your details in',
      );
      expect(await passes()).toEqual([]);

      // A number not proved here can't forget one: a code is asked for first.
      const stranger = await checkout(f.b);
      const refused = open(
        await f.checkouts.forgetPass(stranger.secret, { phone: '0300 7654321' }),
      );
      expect(refused.problem).toMatchObject({ kind: 'recall', state: 'sent' });
    });
  },
);
