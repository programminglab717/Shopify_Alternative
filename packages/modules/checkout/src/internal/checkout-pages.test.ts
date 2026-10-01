import type { OrderRecord } from '@hatti/orders/public';
import type { DiscountCodeRecord } from '@hatti/pricing/public';
import type { CartJson } from '@hatti/storefront-api';
import { describe, expect, it } from 'vitest';
import { checkoutPage } from './checkout-pages.js';
import { EMPTY_FORM, type CheckoutView } from './checkout.service.js';
import { NO_COD_RULES } from './cod-rules.js';
import type { DeliverySettingsRecord } from './delivery.js';

const SHOP = { name: 'Zari', storefront: 'https://zari.hatti.test', policies: [], accent: null };

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
  discount: null,
  totalDiscount: 0,
};

const DELIVERY: DeliverySettingsRecord = {
  charge: 250_00n,
  freeAbove: null,
  zones: [{ name: 'Karachi', cities: ['Karachi'], charge: 150_00n }],
  updatedAt: null,
};

const EID25: DiscountCodeRecord = {
  id: 'd1',
  code: 'EID25',
  title: 'EID25',
  kind: 'percentage',
  percentageBps: 2_500,
  amount: null,
  minimumSubtotal: null,
  startsAt: new Date('2026-10-01T00:00:00+05:00'),
  endsAt: null,
  usageLimit: null,
  oncePerCustomer: false,
  used: 0,
  version: 1,
  createdAt: new Date('2026-10-01T00:00:00+05:00'),
  updatedAt: new Date('2026-10-01T00:00:00+05:00'),
};

const ORDER = {
  number: 1001,
  subtotal: 4_000_00n,
  discount: 0n,
  discountCodes: [],
  shipping: 150_00n,
  total: 4_150_00n,
  codAmount: 4_150_00n,
  shippingAddress: {
    name: 'Ayesha Khan',
    phone: '+923001234567',
    address1: 'House 12',
    address2: 'Gulshan-e-Iqbal',
    landmark: 'Near Jamia Masjid',
    city: 'Karachi',
    provinceCode: 'SD',
    zip: null,
  },
  lines: [{ quantity: 2, title: 'Kurta', variantTitle: 'M', total: 4_000_00n }],
} as unknown as OrderRecord;

const ACCOUNT = {
  title: 'Zari Textiles',
  bankName: 'Standard Chartered',
  iban: 'PK36SCBL0000001123456702',
  instructions: 'Send the receipt to 0300 1234567 on WhatsApp.',
};

function openView(
  changes: Partial<Extract<CheckoutView, { kind: 'open' }>> = {},
): Extract<CheckoutView, { kind: 'open' }> {
  return {
    kind: 'open',
    shop: SHOP,
    cartId: 'c1',
    cart: CART,
    delivery: DELIVERY,
    discount: null,
    payments: { codRefusal: null, codRules: NO_COD_RULES, bankTransfer: null },
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
    for (const name of ['name', 'phone', 'city', 'address1', 'address2', 'landmark', 'province']) {
      expect(page.html).toContain(`name="${name}"`);
    }
    expect(page.html).toContain('autocomplete="shipping tel"');
    expect(page.html).toContain('<option value="Karachi"></option>');
    // The area and the landmark in boxes of their own: with no city yet, every listed city's
    // areas are suggested, each by its city.
    expect(page.html).toMatch(/name="address2"[^>]*list="areas"/);
    expect(page.html).toContain('<option value="Clifton" label="Karachi"></option>');
    expect(page.html).toContain('<option value="G-11" label="Islamabad"></option>');
    expect(page.html).toContain('autocomplete="shipping address-line3"');
    expect(page.html).toContain('A mosque, school or shop near you that the rider can ask for.');
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
    // The city's own areas, now it is known.
    expect(typed.html).toContain('<option value="Clifton"></option>');
    expect(typed.html).not.toContain('label="Islamabad"');
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
      'Your cart, the delivery charges or the shop&#39;s policies changed while you were here.',
    );
    expect(checkoutPage(openView({ problem: { kind: 'unavailable' } })).html).toContain(
      'Some of your cart is no longer available.',
    );
    expect(checkoutPage(openView({ problem: { kind: 'refused' } })).html).toContain(
      'Sorry, the shop can&#39;t take orders right now.',
    );
    // More cash on delivery than the law allows: nothing to fill in, only the cart to change.
    const limited = checkoutPage(
      openView({ problem: { kind: 'cod_limit' }, delivery: { ...DELIVERY, zones: [] } }),
    );
    expect(limited.status).toBe(409);
    expect(limited.html).toContain(
      'By law, cash on delivery can&#39;t collect more than Rs 200,000 an order. Remove some ' +
        'items from your cart, or ask the shop about paying part in advance.',
    );
    expect(limited.html).toContain('<bdi dir="ltr">Rs 200,000</bdi>');
    // No address to fill in; a discount code may yet bring it under the limit.
    expect(limited.html).not.toContain('name="shown"');
    expect(limited.html).toContain('name="discount"');
    // What it comes to, which is not paid on delivery.
    expect(limited.html).not.toContain('Pay on delivery');
    expect(limited.html).toMatch(/Total.*Rs 4,250/s);
    expect(limited.html).toContain('<a href="https://zari.hatti.test/cart">');
  });

  it('thanks the shopper for the order placed, and says what they pay when', () => {
    const page = checkoutPage({ kind: 'placed', shop: SHOP, order: ORDER });
    expect(page.status).toBe(200);
    expect(page.html).toContain('Thank you!');
    expect(page.html).toContain('Your order #1001 is placed.');
    expect(page.html).toContain('on 0300 ••••567');
    expect(page.html).not.toContain('1234567');
    expect(page.html).toContain('You pay Rs 4,150 when it arrives.');
    expect(page.html).toMatch(
      /House 12<\/bdi><br \/>\s*<bdi>Gulshan-e-Iqbal<\/bdi><br \/>\s*<bdi>Near Jamia Masjid<\/bdi><br \/>/,
    );
    expect(page.html).toContain('Karachi, Sindh');
    expect(page.html).not.toContain('<form');
  });

  it('offers paying on delivery or by bank transfer, on delivery unless chosen otherwise', () => {
    const payments = { codRefusal: null, codRules: NO_COD_RULES, bankTransfer: ACCOUNT };
    const page = checkoutPage(openView({ payments }));
    expect(page.html).toContain('role="radiogroup" aria-labelledby="payment"');
    expect(page.html).toMatch(/name="payment" value="cash_on_delivery"\s+checked/);
    expect(page.html).toMatch(/name="payment" value="bank_transfer"\s*\/>/);
    expect(page.html).toContain(
      'Bank transfer: once your order is placed, you see Zari&#39;s account at Standard Chartered, and ' +
        'they send your order when the money is in.',
    );
    // The account itself comes with the order's number, once it is placed.
    expect(page.html).not.toContain('PK36');
    // Either way, it is the total: not necessarily paid on delivery.
    expect(page.html).not.toContain('Pay on delivery');
    const chosen = checkoutPage(
      openView({ payments, form: { ...EMPTY_FORM, payment: 'bank_transfer' } }),
    );
    expect(chosen.html).toMatch(/name="payment" value="cash_on_delivery"\s*\/>/);
    expect(chosen.html).toMatch(/name="payment" value="bank_transfer"\s+checked/);

    // Above what cash on delivery may collect, a transfer is the way to pay.
    const above = checkoutPage(
      openView({
        payments: { codRefusal: { reason: 'law' }, codRules: NO_COD_RULES, bankTransfer: ACCOUNT },
      }),
    );
    expect(above.status).toBe(200);
    expect(above.html).toContain('<input type="hidden" name="payment" value="bank_transfer" />');
    expect(above.html).not.toContain('type="radio"');
    expect(above.html).toContain(
      'By law, cash on delivery can&#39;t collect more than Rs 200,000 an order.',
    );
    expect(above.html).toContain('name="shown"');
  });

  it("states the shop's rules for cash on delivery, and why they kept it from an order", () => {
    const codRules = {
      maxOrderTotal: 25_000_00n,
      unavailableCities: ['Gilgit', 'Skardu'],
      refusedDeliveriesLimit: 2,
      updatedAt: null,
    };
    // Beside a transfer, in its option; alone, under it.
    const both = checkoutPage(
      openView({ payments: { codRefusal: null, codRules, bankTransfer: ACCOUNT } }),
    );
    expect(both.html).toContain(
      'Cash on delivery: you pay when your order arrives. Up to Rs 25,000 an order, and not in ' +
        'Gilgit or Skardu.',
    );
    expect(both.html).toContain('گلگت اور سکردو میں نہیں');
    const cities = ['Gilgit', 'Skardu', 'Hunza', 'Chitral', 'Gwadar', 'Turbat', 'Khuzdar'];
    const alone = checkoutPage(
      openView({
        payments: {
          codRefusal: null,
          codRules: { ...codRules, maxOrderTotal: null, unavailableCities: cities },
          bankTransfer: null,
        },
      }),
    );
    expect(alone.html).toContain(
      'Not in Gilgit, Skardu, Hunza, Chitral, Gwadar and 2 more cities.',
    );

    // Kept from an order to a city: a transfer is chosen for the shopper.
    const city = checkoutPage(
      openView({
        payments: { codRefusal: null, codRules, bankTransfer: ACCOUNT },
        form: { ...EMPTY_FORM, payment: 'bank_transfer' },
        problem: { kind: 'cod_unavailable', refusal: { reason: 'city', city: 'Gilgit' } },
      }),
    );
    expect(city.status).toBe(409);
    expect(city.html).toContain(
      'Cash on delivery isn&#39;t available in Gilgit. Pay by bank transfer instead.',
    );
    expect(city.html).toContain('<bdi>گلگت</bdi> میں ڈیلیوری پر نقد ادائیگی دستیاب نہیں۔');
    expect(city.html).toMatch(/name="payment" value="bank_transfer"\s+checked/);
    // Kept from its customer, who is not told why; with no transfer, they ask the shop.
    const customer = checkoutPage(
      openView({
        payments: { codRefusal: null, codRules, bankTransfer: null },
        problem: { kind: 'cod_unavailable', refusal: { reason: 'customer' } },
      }),
    );
    expect(customer.html).toContain(
      'Cash on delivery isn&#39;t available for this order. Ask the shop how else you can pay.',
    );
    expect(customer.html).toContain('name="shown"');

    // Kept from the cart before the shopper types: transfer alone, or nothing to fill in.
    const refusal = { reason: 'total', max: 10_000_00n } as const;
    const above = checkoutPage(
      openView({ payments: { codRefusal: refusal, codRules, bankTransfer: ACCOUNT } }),
    );
    expect(above.html).toContain('<input type="hidden" name="payment" value="bank_transfer" />');
    expect(above.html).toContain('Cash on delivery is for orders up to Rs 10,000.');
    const none = checkoutPage(
      openView({
        payments: { codRefusal: refusal, codRules, bankTransfer: null },
        problem: { kind: 'cod_unavailable', refusal },
      }),
    );
    expect(none.html).not.toContain('name="shown"');
    expect(none.html).toContain(
      'Cash on delivery is for orders up to Rs 10,000. Remove some items from your cart, or ask ' +
        'the shop how else you can pay.',
    );
  });

  it('tells the shopper where to pay a transfer, with the order as its reference', () => {
    const transfer = {
      ...ORDER,
      currency: 'PKR',
      paymentMethod: 'bank_transfer',
      stage: 'awaiting_payment',
      amountPaid: 0n,
      codAmount: 0n,
      bankAccount: ACCOUNT,
    } as OrderRecord;
    const page = checkoutPage({ kind: 'placed', shop: SHOP, order: transfer });
    expect(page.html).toContain(
      'Your order #1001 is placed. Pay Rs 4,150 by bank transfer, with #1001 as the reference: ' +
        'Zari sends your order once the money is in.',
    );
    expect(page.html).toContain(
      '<bdi dir="ltr" class="select-all">PK36 SCBL 0000 0011 2345 6702</bdi>',
    );
    expect(page.html).toContain('<bdi>Send the receipt to 0300 1234567 on WhatsApp.</bdi>');
    expect(page.html).not.toContain('when it arrives');
    expect(page.html).not.toContain('call or message');
    // Held for review, the shop gets in touch first; paid, there is nothing to pay.
    for (const stage of ['needs_review', 'to_pack'] as const) {
      const later = checkoutPage({ kind: 'placed', shop: SHOP, order: { ...transfer, stage } });
      expect(later.html).toContain('Your order #1001 is placed. Zari will be in touch');
      expect(later.html).not.toContain('PK36');
    }
  });

  it("links the shop's policies at the foot of the page, each opening beside the checkout", () => {
    const shop = {
      ...SHOP,
      policies: [
        { type: 'refund_policy', versionId: 'v1' },
        { type: 'shipping_policy', versionId: 'v2' },
      ] as const,
    };
    const open = checkoutPage(openView({ shop })).html;
    expect(open).toContain(
      '<nav class="section center small" aria-label="Policies"><p><a ' +
        'href="https://zari.hatti.test/policies/refund-policy" target="_blank" rel="noopener">' +
        '<span class="both"><span lang="en">Refund policy</span> ' +
        '<span lang="ur" dir="rtl">واپسی کی پالیسی</span></span></a></p>',
    );
    expect(open).toContain('href="https://zari.hatti.test/policies/shipping-policy"');
    expect(open.indexOf('<nav')).toBeGreaterThan(open.indexOf('</form>'));
    expect(open).not.toContain('privacy-policy');
    // Once the order is placed too; a shop without policies has none to link.
    const placed = checkoutPage({ kind: 'placed', shop, order: ORDER }).html;
    expect(placed).toContain('href="https://zari.hatti.test/policies/shipping-policy"');
    expect(checkoutPage(openView()).html).not.toContain('<nav');
  });

  it('says what placing the order agrees to, above its button, each policy linked', () => {
    const link = (handle: string, title: string) =>
      `<a href="https://zari.hatti.test/policies/${handle}" target="_blank" rel="noopener">` +
      `${title}</a>`;
    const shop = {
      ...SHOP,
      policies: [
        { type: 'refund_policy', versionId: 'v1' },
        { type: 'terms_of_service', versionId: 'v2' },
        { type: 'shipping_policy', versionId: 'v3' },
        { type: 'contact_information', versionId: 'v4' },
      ] as const,
    };
    const page = checkoutPage(openView({ shop })).html;
    expect(page).toContain(
      `<p lang="en">By placing your order, you agree to the shop's ` +
        `${link('refund-policy', 'refund policy')}, ` +
        `${link('terms-of-service', 'terms of service')} and ` +
        `${link('shipping-policy', 'shipping policy')}.</p>`,
    );
    expect(page).toContain(
      '<p lang="ur" dir="rtl">آرڈر دے کر آپ دکان کی ان پالیسیوں سے اتفاق کرتے ہیں: ' +
        `${link('refund-policy', 'واپسی کی پالیسی')}، ` +
        `${link('terms-of-service', 'شرائط و ضوابط')} اور ` +
        `${link('shipping-policy', 'ترسیل کی پالیسی')}۔</p>`,
    );
    // Above the button that places the order, the last on the page.
    expect(page.indexOf('you agree to')).toBeLessThan(page.lastIndexOf('type="submit"'));
    // Contact information promises nothing: it is only at the foot of the page.
    expect(page.match(/contact-information/g)).toHaveLength(1);

    const refundOnly = { ...SHOP, policies: [{ type: 'refund_policy', versionId: 'v1' }] as const };
    expect(checkoutPage(openView({ shop: refundOnly })).html).toContain(
      `you agree to the shop's ${link('refund-policy', 'refund policy')}.</p>`,
    );
    const contactOnly = {
      ...SHOP,
      policies: [{ type: 'contact_information', versionId: 'v4' }] as const,
    };
    expect(checkoutPage(openView({ shop: contactOnly })).html).not.toContain('you agree');
    expect(checkoutPage(openView()).html).not.toContain('you agree');
  });

  it("is in the shop's colour, its own style allowed by its hash, wherever the shop shows", () => {
    const amber = { ...SHOP, accent: '#B45309' };
    const style = ':root { --accent: #B45309; --on-accent: #FFFFFF; --link: #B45309; }';
    const pages = [
      checkoutPage(openView({ shop: amber })),
      checkoutPage({ kind: 'placed', shop: amber, order: ORDER }),
      checkoutPage({ kind: 'expired', shop: amber }),
      checkoutPage({ kind: 'empty', shop: amber }),
    ];
    for (const page of pages) {
      expect(page.html).toContain(`<style>${style}</style>`);
      expect(page.contentSecurityPolicy.match(/'sha256-/g)).toHaveLength(2);
    }
    // The platform's, for a shop that leaves it, and where there is no shop to show.
    for (const page of [checkoutPage(openView()), checkoutPage({ kind: 'not_found' })]) {
      expect(page.html).not.toContain('--accent:');
      expect(page.contentSecurityPolicy.match(/'sha256-/g)).toHaveLength(1);
    }
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

  it('takes a discount code in a form of its own, and shows what it takes off', () => {
    const none = checkoutPage(openView()).html;
    expect(none).toContain('<input type="hidden" name="action" value="discount" />');
    expect(none).toContain('name="discount"');
    expect(none).not.toContain('remove_discount');

    const applied = checkoutPage(
      openView({ discount: { code: 'EID25', record: EID25, refusal: null } }),
    ).html;
    expect(applied).toContain('Discount (EID25)');
    // The code once: the Urdu label says only the word.
    expect(applied.match(/EID25\)/g)).toHaveLength(1);
    expect(applied).toContain('−Rs 1,000');
    expect(applied).toContain('is applied.');
    expect(applied).toContain('<input type="hidden" name="action" value="remove_discount" />');
    expect(applied).not.toContain('name="discount"');
    // Delivery is still by city until one is typed.
    expect(applied).not.toContain('Pay on delivery');
    const karachi = checkoutPage(
      openView({
        discount: { code: 'EID25', record: EID25, refusal: null },
        form: { ...EMPTY_FORM, city: 'Karachi' },
      }),
    ).html;
    // Rs 4,000 less Rs 1,000, and Rs 150 to Karachi.
    expect(karachi).toMatch(/Pay on delivery[\s\S]*Rs 3,150/);

    const free = checkoutPage(
      openView({
        discount: {
          code: 'FREE',
          record: { ...EID25, code: 'FREE', kind: 'free_shipping', percentageBps: null },
          refusal: null,
        },
      }),
    ).html;
    // Free wherever it goes: the total is known before the city is.
    expect(free).toMatch(/Pay on delivery[\s\S]*Rs 4,000/);
    expect(free).not.toContain('−Rs');
  });

  it('says why a code takes nothing off, by its field, in both languages', () => {
    const typed = checkoutPage(
      openView({
        problem: { kind: 'discount', code: '<EID>', refusal: { reason: 'unknown' } },
      }),
    );
    expect(typed.status).toBe(422);
    expect(typed.html).toContain('value="&lt;EID&gt;"');
    expect(typed.html).toContain('aria-invalid="true" aria-describedby="discount-error"');
    expect(typed.html).toContain('no discount code');
    expect(typed.html).not.toContain('class="banner"');

    const kept = checkoutPage(
      openView({
        discount: {
          code: 'EID25',
          record: null,
          refusal: { reason: 'minimum', minimum: 5_000_00n },
        },
      }),
    ).html;
    expect(kept).toContain('is for orders of Rs 5,000 or more.');
    expect(kept).toContain('یا زیادہ کے آرڈر کے لیے ہے');
    expect(kept).toContain('remove_discount');
    expect(kept).not.toContain('−Rs');

    for (const [refusal, en] of [
      [{ reason: 'expired' }, 'has ended.'],
      [{ reason: 'used_up' }, 'has been used up.'],
      [{ reason: 'used' }, 'Remove it to place your order.'],
      [{ reason: 'attempts' }, 'This checkout can&#39;t take more discount codes.'],
      [{ reason: 'scheduled', startsAt: new Date('2026-10-05T00:00:00+05:00') }, '5 October 2026'],
    ] as const) {
      const html = checkoutPage(
        openView({ problem: { kind: 'discount', code: 'EID25', refusal } }),
      ).html;
      expect(html, refusal.reason).toContain(en);
    }
  });

  it('shows the discount the order was placed with', () => {
    const html = checkoutPage({
      kind: 'placed',
      shop: SHOP,
      order: {
        ...ORDER,
        discount: 1_000_00n,
        discountCodes: ['EID25'],
        total: 3_150_00n,
        codAmount: 3_150_00n,
      },
    }).html;
    expect(html).toContain('Discount (EID25)');
    expect(html).toContain('−Rs 1,000');
    expect(html).toContain('You pay Rs 3,150 when it arrives.');
  });
});
