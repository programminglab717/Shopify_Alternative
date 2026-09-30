import type { OrderRecord } from '@hatti/orders/public';
import type { CartJson } from '@hatti/storefront-api';
import { describe, expect, it } from 'vitest';
import { checkoutPage } from './checkout-pages.js';
import { EMPTY_FORM, type CheckoutView } from './checkout.service.js';
import type { DeliverySettingsRecord } from './delivery.js';

const SHOP = { name: 'Zari', storefront: 'https://zari.hatti.test', policies: [] };

const CART: CartJson = {
  note: 'Please call first',
  attributes: {},
  items: [
    {
      key: 'v1:abc',
      variantId: 'v1',
      productId: 'p1',
      quantity: 2,
      properties: { Name: 'Ali', _bundle: '7' },
      price: 2_000_00,
      linePrice: 4_000_00,
      title: 'Kurta',
      variantTitle: 'M',
      sku: null,
      grams: 0,
      maxQuantity: null,
    },
  ],
  itemCount: 2,
  subtotal: 4_000_00,
  totalWeightGrams: 0,
};

const DELIVERY: DeliverySettingsRecord = {
  charge: 250_00n,
  freeAbove: null,
  zones: [{ name: 'Karachi', cities: ['Karachi'], charge: 150_00n }],
  updatedAt: null,
};

const ORDER = {
  number: 1001,
  subtotal: 4_000_00n,
  shipping: 150_00n,
  total: 4_150_00n,
  codAmount: 4_150_00n,
  shippingAddress: {
    name: 'Ayesha Khan',
    phone: '+923001234567',
    address1: 'House 12',
    address2: null,
    city: 'Karachi',
    provinceCode: 'SD',
    zip: null,
  },
  lines: [{ quantity: 2, title: 'Kurta', variantTitle: 'M', total: 4_000_00n }],
} as unknown as OrderRecord;

function openView(
  changes: Partial<Extract<CheckoutView, { kind: 'open' }>> = {},
): Extract<CheckoutView, { kind: 'open' }> {
  return {
    kind: 'open',
    shop: SHOP,
    cartId: 'c1',
    cart: CART,
    delivery: DELIVERY,
    shown: 'digest-of-the-page',
    form: EMPTY_FORM,
    problem: null,
    ...changes,
  };
}

describe('checkoutPage', () => {
  it('shows the cart, what delivery costs where, and the form, with no scripts', () => {
    const page = checkoutPage(openView());
    expect(page.status).toBe(200);
    expect(page.html).toContain('<title>Checkout · Zari</title>');
    expect(page.html).toContain('<input type="hidden" name="shown" value="digest-of-the-page" />');
    for (const name of ['name', 'phone', 'city', 'address1', 'address2', 'province']) {
      expect(page.html).toContain(`name="${name}"`);
    }
    expect(page.html).toContain('autocomplete="shipping tel"');
    expect(page.html).toContain('<option value="Karachi"></option>');
    // The properties shoppers see; those for apps stay hidden.
    expect(page.html).toContain('Name: Ali');
    expect(page.html).not.toContain('_bundle');
    // No city yet, and cities cost differently: the charges, not a total.
    expect(page.html).toContain('By city');
    expect(page.html).toContain('Delivery is Rs 250; Rs 150 in Karachi.');
    expect(page.html).toContain(
      'ڈیلیوری <bdi dir="ltr">Rs 250</bdi>؛ <bdi dir="ltr">Karachi</bdi> میں <bdi dir="ltr">Rs 150</bdi>۔',
    );
    expect(page.html).not.toContain('Pay on delivery');
    expect(page.html).toContain('Cash on delivery: you pay when your order arrives.');
    expect(page.html).toContain('Please call first');
    expect(page.html).toContain('<a href="https://zari.hatti.test/cart">');
    expect(page.html).not.toContain('<script');
    expect(page.contentSecurityPolicy).toContain("form-action 'self'");
  });

  it('shows what the shopper pays once delivery is known', () => {
    const typed = checkoutPage(openView({ form: { ...EMPTY_FORM, city: 'khi' } }));
    expect(typed.html).toMatch(/Pay on delivery.*Rs 4,150/s);
    const everywhere = checkoutPage(openView({ delivery: { ...DELIVERY, zones: [] } }));
    expect(everywhere.html).toMatch(/Pay on delivery.*Rs 4,250/s);
    const free = checkoutPage(openView({ delivery: { ...DELIVERY, freeAbove: 3_000_00n } }));
    expect(free.html).toMatch(/Delivery.*Free.*Pay on delivery.*Rs 4,000/s);
  });

  it('says what is wrong, beside the boxes, keeping what was typed', () => {
    const form = { ...EMPTY_FORM, name: '<b>Ayesha</b>', phone: '12345' };
    const page = checkoutPage(
      openView({
        form,
        problem: {
          kind: 'address',
          errors: [
            { field: ['phone'], code: 'INVALID', message: 'Phone must be a Pakistani mobile' },
            { field: ['city'], code: 'BLANK', message: "City can't be blank" },
          ],
        },
      }),
    );
    expect(page.status).toBe(422);
    expect(page.html).toContain('role="alert"');
    expect(page.html).toContain('value="&lt;b&gt;Ayesha&lt;/b&gt;"');
    expect(page.html).not.toContain('<b>Ayesha');
    expect(page.html).toMatch(/id="phone"[^>]*aria-invalid="true"/s);
    expect(page.html).toContain('Enter a Pakistani mobile number, like 0300 1234567.');
    expect(page.html).toContain('Enter the city.');
    expect(page.html).not.toMatch(/id="name"[^>]*aria-invalid/s);
  });

  it('says why the order was not placed', () => {
    expect(checkoutPage(openView({ problem: { kind: 'changed' } }))).toMatchObject({
      status: 409,
    });
    expect(checkoutPage(openView({ problem: { kind: 'changed' } })).html).toContain(
      'Your cart or the delivery charges changed while you were here.',
    );
    expect(checkoutPage(openView({ problem: { kind: 'unavailable' } })).html).toContain(
      'Some of your cart is no longer available.',
    );
    expect(checkoutPage(openView({ problem: { kind: 'refused' } })).html).toContain(
      'Sorry, the shop can&#39;t take orders right now.',
    );
  });

  it('thanks the shopper for the order placed, and says what they pay when', () => {
    const page = checkoutPage({ kind: 'placed', shop: SHOP, order: ORDER });
    expect(page.status).toBe(200);
    expect(page.html).toContain('Thank you!');
    expect(page.html).toContain('Your order #1001 is placed.');
    expect(page.html).toContain('on 0300 ••••567');
    expect(page.html).not.toContain('1234567');
    expect(page.html).toContain('You pay Rs 4,150 when it arrives.');
    expect(page.html).toContain('Karachi, Sindh');
    expect(page.html).not.toContain('<form');
  });

  it("links the shop's policies at the foot of the page, each opening beside the checkout", () => {
    const shop = { ...SHOP, policies: ['refund_policy', 'shipping_policy'] as const };
    const open = checkoutPage(openView({ shop })).html;
    expect(open).toContain(
      '<nav class="section center small" aria-label="Policies"><p><a ' +
        'href="https://zari.hatti.test/policies/refund-policy" target="_blank" rel="noopener">' +
        '<span class="both"><span lang="en">Refund policy</span> ' +
        '<span lang="ur" dir="rtl">واپسی کی پالیسی</span></span></a></p>',
    );
    expect(open).toContain('href="https://zari.hatti.test/policies/shipping-policy"');
    expect(open.indexOf('/policies/refund-policy')).toBeGreaterThan(open.indexOf('</form>'));
    expect(open).not.toContain('privacy-policy');
    // Once the order is placed too; a shop without policies has none to link.
    const placed = checkoutPage({ kind: 'placed', shop, order: ORDER }).html;
    expect(placed).toContain('href="https://zari.hatti.test/policies/shipping-policy"');
    expect(checkoutPage(openView()).html).not.toContain('<nav');
  });

  it('shows nothing of a checkout it cannot find, or one expired', () => {
    const missing = checkoutPage({ kind: 'not_found' });
    expect(missing.status).toBe(404);
    expect(missing.html).not.toContain('Zari');
    const expired = checkoutPage({ kind: 'expired', shop: SHOP });
    expect(expired.status).toBe(410);
    expect(expired.html).toContain('This checkout has expired');
    expect(expired.html).toContain('<a href="https://zari.hatti.test/cart">');
    const empty = checkoutPage({ kind: 'empty', shop: SHOP });
    expect([empty.status, empty.html.includes('Your cart is empty')]).toEqual([200, true]);
  });
});
