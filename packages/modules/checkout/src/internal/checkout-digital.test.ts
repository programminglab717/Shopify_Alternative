import 'reflect-metadata';
import type { TenantContext } from '@hatti/api';
import { DigitalProductService } from '@hatti/catalog/public';
import { testDatabaseServer } from '@hatti/db/testing';
import type { CartActionName } from '@hatti/storefront-api';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseAction } from './cart-lines.js';
import { checkoutPage } from './checkout-pages.js';
import { DIGITAL_ADDRESS, type CheckoutForm, type CheckoutView } from './checkout.service.js';
import { checkoutFixture, unwrap, type CheckoutFixture } from './test-support.js';

const server = testDatabaseServer();

/** A shopper buying downloads: their name and number, no address. */
const BUYING: CheckoutForm = {
  name: 'Ayesha Khan',
  phone: '0300-1234567',
  city: '',
  address1: '',
  address2: '',
  landmark: '',
  province: '',
  payment: '',
  code: '',
  resend: '',
};

describe.skipIf(!server)('Checking out digital products alone (CAT-13, ADR-815)', () => {
  let f: CheckoutFixture;

  beforeAll(async () => {
    f = await checkoutFixture(server!);
  });

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
    unwrap(await f.delivery.update(f.a, { charge: '250' }));
  });

  async function act(
    owner: TenantContext,
    token: string | null,
    name: CartActionName,
    body: unknown,
  ) {
    const action = parseAction(name, body);
    if ('code' in action) throw new Error(`Refused: ${JSON.stringify(action)}`);
    const result = await f.carts.act(owner.shopId, token, action);
    if (!result.ok) throw new Error(`Refused: ${JSON.stringify(result.error)}`);
    return result.token!;
  }

  function open(view: CheckoutView) {
    if (view.kind !== 'open') throw new Error(`Expected an open checkout, got ${view.kind}`);
    return view;
  }

  /** A variant of a product titled `title`, in stock, made digital where `digital`. */
  async function variant(title: string, digital: boolean): Promise<string> {
    const [id] = await f.variantsOf(f.a, title, { price: '1,500' });
    await f.stock(f.a, id!, 5);
    if (digital) {
      const { rows } = await f.admin.query<{ product_id: string }>(
        'SELECT product_id FROM catalog.variants WHERE id = $1',
        [id],
      );
      unwrap(await new DigitalProductService(f.db).set(f.a, rows[0]!.product_id, {}));
    }
    return id!;
  }

  /** A checkout of these, and its page. */
  async function started(...variantIds: string[]) {
    const token = await act(f.a, null, 'add', {
      items: variantIds.map((variantId) => ({ variantId, quantity: 1 })),
    });
    const secret = (await f.checkouts.start(f.a.shopId, token))!;
    return { secret, view: open(await f.checkouts.view(secret)) };
  }

  const transfer = () =>
    f.bankTransfer.update(f.a, {
      enabled: true,
      account: { title: 'Zari', bankName: 'Standard Chartered', iban: 'PK36SCBL0000001123456702' },
    });

  it('asks for no address and charges no delivery, paid in advance alone, and places it online', async () => {
    unwrap(await transfer());
    const patterns = await variant('Embroidery patterns', true);
    const { secret, view } = await started(patterns);
    expect(view).toMatchObject({ digital: true, pickup: [] });
    expect(view.payments.codRefusal).toEqual({ reason: 'digital' });
    const page = checkoutPage(view).html;
    expect(page).not.toContain('name="address1"');
    expect(page).not.toContain('name="city"');
    expect(page).toContain('Your downloads and keys come to this number on WhatsApp.');
    expect(page).not.toContain('>Delivery<');

    const placed = await f.checkouts.place(secret, view.shown, BUYING);
    if (placed.kind !== 'placed') {
      throw new Error(`Expected a placed order, got ${JSON.stringify(placed)}`);
    }
    expect(placed.order).toMatchObject({
      paymentMethod: 'bank_transfer',
      shipping: 0n,
      total: 1_500_00n,
      shippingAddress: {
        name: 'Ayesha Khan',
        phone: '+923001234567',
        address1: DIGITAL_ADDRESS.address1,
        city: DIGITAL_ADDRESS.city,
      },
    });
    expect(checkoutPage(placed).html).toContain(
      'Once it is paid, your downloads and keys come to your number on WhatsApp.',
    );
  });

  it('says it is paid in advance where the shop takes no advance payments, and asks the rest of a cart with goods as ever', async () => {
    const patterns = await variant('Embroidery patterns', true);
    const alone = await started(patterns);
    expect(alone.view.problem).toEqual({
      kind: 'cod_unavailable',
      refusal: { reason: 'digital' },
    });
    expect(checkoutPage(alone.view).html).toContain('Downloads and keys are paid in advance.');

    // With a kurta, it is delivered as any cart is: an address, delivery and cash on delivery.
    const kurta = await variant('Kurta', false);
    const mixed = await started(patterns, kurta);
    expect(mixed.view.digital).toBeUndefined();
    expect(mixed.view.payments.codRefusal).toBeNull();
    expect(checkoutPage(mixed.view).html).toContain('name="address1"');
  });
});
