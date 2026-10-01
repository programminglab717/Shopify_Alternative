import type { OrderRecord } from '@hatti/orders/public';
import type { DiscountCodeRecord } from '@hatti/pricing/public';
import type { CartJson } from '@hatti/storefront-api';
import { NO_TAX } from '@hatti/tax/public';
import { describe, expect, it } from 'vitest';
import { checkoutPage } from './checkout-pages.js';
import { EMPTY_FORM, type CheckoutShop, type CheckoutView } from './checkout.service.js';
import { NO_COD_RULES, type CodAdvanceValue } from './cod-rules.js';
import type { DeliverySettingsRecord } from './delivery.js';

/** An advance's conditions when it asks every order. */
const EVERY_ORDER = {
  above: null,
  cities: [],
  refusedDeliveries: null,
  newCustomers: false,
  riskScore: null,
};

const SHOP: CheckoutShop = {
  name: 'Zari',
  storefront: 'https://zari.hatti.test',
  policies: [],
  accent: null,
  logo: null,
  badges: [],
  whatsapp: null,
};

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
      taxable: true,
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
  transferDiscount: 0n,
  discountCodes: [],
  shipping: 150_00n,
  total: 4_150_00n,
  codAmount: 4_150_00n,
  taxRate: null,
  totalTax: 0n,
  shippingTax: 0n,
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
  lines: [
    {
      quantity: 2,
      title: 'Kurta',
      variantTitle: 'M',
      total: 4_000_00n,
      taxable: true,
      taxRate: null,
      tax: 0n,
    },
  ],
} as unknown as OrderRecord;

const ACCOUNT = {
  title: 'Zari Textiles',
  bankName: 'Standard Chartered',
  iban: 'PK36SCBL0000001123456702',
  instructions: 'Send the receipt to 0300 1234567 on WhatsApp.',
  raastId: '+923001234567',
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
    payments: {
      codRefusal: null,
      codRules: NO_COD_RULES,
      bankTransfer: null,
      transferDiscount: null,
      advance: null,
    },
    tax: NO_TAX,
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
    const payments = {
      codRefusal: null,
      codRules: NO_COD_RULES,
      bankTransfer: ACCOUNT,
      transferDiscount: null,
      advance: null,
    };
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
        payments: {
          codRefusal: { reason: 'law' },
          codRules: NO_COD_RULES,
          bankTransfer: ACCOUNT,
          transferDiscount: null,
          advance: null,
        },
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
      unavailableProductTags: [],
      refusedDeliveriesLimit: 2,
      fee: 0n,
      advance: null,
      updatedAt: null,
    };
    // Beside a transfer, in its option; alone, under it.
    const both = checkoutPage(
      openView({
        payments: {
          codRefusal: null,
          codRules,
          bankTransfer: ACCOUNT,
          transferDiscount: null,
          advance: null,
        },
      }),
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
          transferDiscount: null,
          advance: null,
        },
      }),
    );
    expect(alone.html).toContain(
      'Not in Gilgit, Skardu, Hunza, Chitral, Gwadar and 2 more cities.',
    );

    // Kept from an order to a city: a transfer is chosen for the shopper.
    const city = checkoutPage(
      openView({
        payments: {
          codRefusal: null,
          codRules,
          bankTransfer: ACCOUNT,
          transferDiscount: null,
          advance: null,
        },
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
        payments: {
          codRefusal: null,
          codRules,
          bankTransfer: null,
          transferDiscount: null,
          advance: null,
        },
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
      openView({
        payments: {
          codRefusal: refusal,
          codRules,
          bankTransfer: ACCOUNT,
          transferDiscount: null,
          advance: null,
        },
      }),
    );
    expect(above.html).toContain('<input type="hidden" name="payment" value="bank_transfer" />');
    expect(above.html).toContain('Cash on delivery is for orders up to Rs 10,000.');
    const none = checkoutPage(
      openView({
        payments: {
          codRefusal: refusal,
          codRules,
          bankTransfer: null,
          transferDiscount: null,
          advance: null,
        },
        problem: { kind: 'cod_unavailable', refusal },
      }),
    );
    expect(none.html).not.toContain('name="shown"');
    expect(none.html).toContain(
      'Cash on delivery is for orders up to Rs 10,000. Remove some items from your cart, or ask ' +
        'the shop how else you can pay.',
    );
  });

  it('names the product that keeps cash on delivery from the cart', () => {
    const refusal = { reason: 'product', title: 'Bridal lehnga' } as const;
    const payments = {
      codRefusal: refusal,
      codRules: NO_COD_RULES,
      bankTransfer: ACCOUNT,
      transferDiscount: null,
      advance: null,
    };
    const alone = checkoutPage(openView({ payments }));
    expect(alone.html).toContain('<input type="hidden" name="payment" value="bank_transfer" />');
    expect(alone.html).toContain('Cash on delivery isn&#39;t available for Bridal lehnga.');
    expect(alone.html).toContain(
      '<bdi>Bridal lehnga</bdi> کے لیے ڈیلیوری پر نقد ادائیگی دستیاب نہیں۔',
    );
    // With no transfer, nothing to fill in: the shopper changes the cart, or asks the shop.
    const none = checkoutPage(
      openView({
        payments: { ...payments, bankTransfer: null },
        problem: { kind: 'cod_unavailable', refusal },
      }),
    );
    expect(none.html).not.toContain('name="shown"');
    expect(none.html).toContain(
      'Cash on delivery isn&#39;t available for Bridal lehnga. Remove it from your cart, or ask ' +
        'the shop how else you can pay.',
    );
  });

  it("adds the shop's fee for paying at the door where it is the only way to pay, and says it beside a transfer", () => {
    const codRules = { ...NO_COD_RULES, fee: 100_00n };
    const flat = { ...DELIVERY, zones: [] };
    const alone = checkoutPage(
      openView({
        delivery: flat,
        payments: {
          codRefusal: null,
          codRules,
          bankTransfer: null,
          transferDiscount: null,
          advance: null,
        },
      }),
    );
    expect(alone.html).toMatch(/Cash on delivery fee<\/span>[\s\S]*?Rs 100/);
    expect(alone.html).toMatch(/Pay on delivery<\/span>[\s\S]*?Rs 4,350/);
    const both = checkoutPage(
      openView({
        delivery: flat,
        payments: {
          codRefusal: null,
          codRules,
          bankTransfer: ACCOUNT,
          transferDiscount: null,
          advance: null,
        },
      }),
    );
    expect(both.html).toContain(
      'Cash on delivery: you pay when your order arrives, with a Rs 100 fee.',
    );
    expect(both.html).not.toContain('Cash on delivery fee');
    expect(both.html).toMatch(/Total<\/span>[\s\S]*?Rs 4,250/);
    // The order keeps it, as its thank-you page says.
    const placed = checkoutPage({
      kind: 'placed',
      shop: SHOP,
      order: { ...ORDER, codFee: 100_00n, total: 4_250_00n, codAmount: 4_250_00n } as OrderRecord,
    });
    expect(placed.html).toMatch(/Cash on delivery fee<\/span>[\s\S]*?Rs 100/);
    expect(placed.html).toContain('You pay Rs 4,250 when it arrives.');
  });

  it('says what paying by transfer takes off, and takes it off where transfer is the only way', () => {
    const flat = { ...DELIVERY, zones: [] };
    const fivePercent = { kind: 'percentage', percentageBps: 500, cap: null } as const;
    const payments = {
      codRefusal: null,
      codRules: NO_COD_RULES,
      bankTransfer: ACCOUNT,
      transferDiscount: fivePercent,
      advance: null,
    };
    // Beside cash on delivery, with its option: 5% of Rs 4,000. The total is either way's.
    const both = checkoutPage(openView({ delivery: flat, payments }));
    expect(both.html).toContain(
      'Bank transfer, Rs 200 off: once your order is placed, you see Zari&#39;s account at ' +
        'Standard Chartered, and they send your order when the money is in.',
    );
    expect(both.html).toContain('بینک ٹرانسفر، <bdi dir="ltr">Rs 200</bdi> کی رعایت:');
    expect(both.html).not.toContain('Bank transfer discount');
    expect(both.html).toMatch(/Total<\/span>[\s\S]*?Rs 4,250/);
    // Off the items after the code: 5% of Rs 3,000, as a cap of Rs 100 would keep it to that.
    const coded = { code: 'EID25', record: EID25, refusal: null };
    expect(checkoutPage(openView({ payments, discount: coded })).html).toContain(
      'Bank transfer, Rs 150 off:',
    );
    expect(
      checkoutPage(
        openView({ payments: { ...payments, transferDiscount: { ...fivePercent, cap: 100_00n } } }),
      ).html,
    ).toContain('Bank transfer, Rs 100 off:');

    // Transfer alone: the summary takes it off.
    const alone = checkoutPage(
      openView({
        delivery: flat,
        payments: {
          ...payments,
          codRefusal: { reason: 'law' },
          transferDiscount: { kind: 'fixed_amount', amount: 300_00n },
        },
      }),
    );
    expect(alone.html).toContain('Bank transfer, Rs 300 off:');
    expect(alone.html).toMatch(/Bank transfer discount<\/span>[\s\S]*?−Rs 300/);
    expect(alone.html).toMatch(/Total<\/span>[\s\S]*?Rs 3,950/);

    // The order keeps it apart from the code's, as its thank-you page says.
    const placed = checkoutPage({
      kind: 'placed',
      shop: SHOP,
      order: {
        ...ORDER,
        currency: 'PKR',
        paymentMethod: 'bank_transfer',
        stage: 'awaiting_payment',
        amountPaid: 0n,
        discount: 1_150_00n,
        transferDiscount: 150_00n,
        discountCodes: ['EID25'],
        total: 3_000_00n,
        codAmount: 0n,
        bankAccount: ACCOUNT,
      } as OrderRecord,
    });
    expect(placed.html).toMatch(
      /Discount \(EID25\)<\/span>[\s\S]*?−Rs 1,000[\s\S]*?Bank transfer discount<\/span>[\s\S]*?−Rs 150/,
    );
    expect(placed.html).toContain('Pay Rs 3,000 by bank transfer');
  });

  it('says what paying on delivery asks for in advance, and takes it off what the door collects', () => {
    const flat = { ...DELIVERY, zones: [] };
    const rules = (advance: CodAdvanceValue) => ({
      codRefusal: null,
      codRules: { ...NO_COD_RULES, fee: 100_00n, advance },
      bankTransfer: null,
      transferDiscount: null,
      advance,
    });
    const fiveHundred: CodAdvanceValue = {
      kind: 'fixed_amount',
      amount: 500_00n,
      ...EVERY_ORDER,
    };
    // Paid on delivery alone: the option says it, and the summary takes it off.
    const alone = checkoutPage(openView({ delivery: flat, payments: rules(fiveHundred) }));
    expect(alone.html).toContain(
      'Cash on delivery: you pay Rs 500 in advance by bank transfer, and the rest when your ' +
        'order arrives.',
    );
    expect(alone.html).toMatch(
      /Cash on delivery fee<\/span>[\s\S]*?Rs 100[\s\S]*?Total<\/span>[\s\S]*?Rs 4,350[\s\S]*?Advance by bank transfer<\/span>[\s\S]*?−Rs 500[\s\S]*?Pay on delivery<\/span>[\s\S]*?Rs 3,850/,
    );
    // Beside a transfer, with the fee, in English and Urdu; the total is either way's.
    const both = checkoutPage(
      openView({ delivery: flat, payments: { ...rules(fiveHundred), bankTransfer: ACCOUNT } }),
    );
    expect(both.html).toContain(
      'Cash on delivery: you pay Rs 500 in advance by bank transfer, and the rest when your ' +
        'order arrives, with a Rs 100 fee.',
    );
    expect(both.html.replace(/\s+/g, ' ')).toContain(
      'ڈیلیوری پر نقد ادائیگی: <bdi dir="ltr">Rs 500</bdi> ایڈوانس بینک ٹرانسفر سے ادا کریں، اور ' +
        'باقی رقم آرڈر ملنے پر، <bdi dir="ltr">Rs 100</bdi> فیس کے ساتھ۔',
    );
    expect(both.html).not.toContain('Advance by bank transfer');
    expect(both.html).toMatch(/Total<\/span>[\s\S]*?Rs 4,250/);
    // A percentage of the items after the code: 20% of Rs 3,000.
    const coded = { code: 'EID25', record: EID25, refusal: null };
    expect(
      checkoutPage(
        openView({
          delivery: flat,
          discount: coded,
          payments: rules({ kind: 'percentage', percentageBps: 2_000, ...EVERY_ORDER }),
        }),
      ).html,
    ).toContain('you pay Rs 600 in advance by bank transfer');
    // The delivery charge: said before the city is typed, and taken off once it is.
    const delivery = rules({ kind: 'delivery', ...EVERY_ORDER });
    const untyped = checkoutPage(openView({ payments: delivery })).html;
    expect(untyped).toContain(
      'Cash on delivery: you pay the delivery charge in advance by bank transfer, and the rest ' +
        'when your order arrives.',
    );
    expect(untyped).toContain('ڈیلیوری چارجز ایڈوانس بینک ٹرانسفر سے ادا کریں');
    expect(untyped).not.toContain('Pay on delivery');
    const typed = checkoutPage(
      openView({ payments: delivery, form: { ...EMPTY_FORM, city: 'khi' } }),
    ).html;
    expect(typed).toContain('you pay the delivery charge in advance');
    expect(typed).toMatch(/Advance by bank transfer<\/span>[\s\S]*?−Rs 150/);
    expect(typed).toMatch(/Pay on delivery<\/span>[\s\S]*?Rs 4,100/);
    // Nothing where delivery is free, or for items at or below its total.
    for (const view of [
      openView({ payments: delivery, delivery: { ...DELIVERY, freeAbove: 3_000_00n } }),
      openView({ delivery: flat, payments: rules({ ...fiveHundred, above: 4_000_00n }) }),
    ]) {
      const html = checkoutPage(view).html;
      expect(html).toContain('Cash on delivery: you pay when your order arrives.');
      expect(html).not.toContain('Advance by bank transfer');
    }

    // Placed, it is paid ahead; once it is in, there is no call to confirm.
    const order = {
      ...ORDER,
      currency: 'PKR',
      paymentMethod: 'cash_on_delivery',
      stage: 'awaiting_payment',
      amountPaid: 0n,
      advanceDue: 500_00n,
      codAmount: 3_650_00n,
      bankAccount: ACCOUNT,
    } as OrderRecord;
    const placed = checkoutPage({ kind: 'placed', shop: SHOP, order }).html;
    expect(placed).toContain(
      'Your order #1001 is placed. Pay Rs 500 in advance by bank transfer, with #1001 as the ' +
        'reference: Zari sends your order once it is in.',
    );
    expect(placed).toContain('You pay Rs 3,650 when it arrives.');
    const paid = checkoutPage({
      kind: 'placed',
      shop: SHOP,
      order: { ...order, stage: 'to_pack', amountPaid: 500_00n },
    }).html;
    expect(paid).toContain('Your order #1001 is placed. Zari will be in touch before sending it.');
    expect(paid).not.toContain('call or message');
  });

  it('says where and of whom it asks for the advance, naming every city, and takes it off once known', () => {
    const flat = { ...DELIVERY, zones: [] };
    const rules = (advance: CodAdvanceValue, fee = 0n) => ({
      codRefusal: null,
      codRules: { ...NO_COD_RULES, fee, advance },
      bankTransfer: null,
      transferDiscount: null,
      advance,
    });
    const cities: CodAdvanceValue = {
      kind: 'fixed_amount',
      amount: 500_00n,
      ...EVERY_ORDER,
      cities: ['Quetta', 'Gilgit', 'Karachi'],
    };
    const page = (advance: CodAdvanceValue, city = '') =>
      checkoutPage(
        openView({ delivery: flat, payments: rules(advance), form: { ...EMPTY_FORM, city } }),
      ).html;
    expect(page(cities)).toContain(
      'Cash on delivery: you pay when your order arrives. On orders to Quetta, Gilgit or ' +
        'Karachi, you pay Rs 500 in advance by bank transfer.',
    );
    expect(page(cities).replace(/\s+/g, ' ')).toContain(
      'ڈیلیوری پر نقد ادائیگی: آرڈر ملنے پر رقم ادا کریں۔ کوئٹہ، گلگت یا کراچی کے آرڈرز پر، ' +
        '<bdi dir="ltr">Rs 500</bdi> ایڈوانس بینک ٹرانسفر سے ادا کریں۔',
    );
    // Taken off what the door collects once the city typed is one of them, and said all the same.
    expect(page(cities)).not.toContain('Advance by bank transfer');
    expect(page(cities, 'khi')).toMatch(/Advance by bank transfer<\/span>[\s\S]*?−Rs 500/);
    expect(page(cities, 'Lahore')).not.toContain('Advance by bank transfer');
    expect(page(cities, 'Lahore')).toContain('On orders to Quetta, Gilgit or Karachi');

    // Of customers who refused before: said, and nobody looked up, whatever the number typed.
    const refusers: CodAdvanceValue = { ...cities, cities: [], refusedDeliveries: 1 };
    expect(page(refusers, 'Quetta')).toContain(
      'Cash on delivery: you pay when your order arrives. If you refused a delivery from this ' +
        'shop before, you pay Rs 500 in advance by bank transfer.',
    );
    expect(page(refusers, 'Quetta')).not.toContain('Advance by bank transfer');
    expect(page(refusers).replace(/\s+/g, ' ')).toContain(
      'اگر آپ پہلے اس دکان کی کوئی ڈیلیوری لینے سے انکار کر چکے ہیں، <bdi dir="ltr">Rs 500</bdi> ' +
        'ایڈوانس بینک ٹرانسفر سے ادا کریں۔',
    );

    // Both, beside a transfer, with the fee; the delivery charge said as it is.
    const both: CodAdvanceValue = {
      kind: 'delivery',
      ...EVERY_ORDER,
      cities: ['Quetta'],
      refusedDeliveries: 2,
    };
    const beside = checkoutPage(
      openView({ payments: { ...rules(both, 100_00n), bankTransfer: ACCOUNT } }),
    ).html;
    expect(beside).toContain(
      'Cash on delivery: you pay when your order arrives, with a Rs 100 fee. On orders to ' +
        'Quetta, if you refused 2 deliveries or more from this shop before, you pay the delivery ' +
        'charge in advance by bank transfer.',
    );
    expect(beside.replace(/\s+/g, ' ')).toContain(
      'کوئٹہ کے آرڈرز پر، اگر آپ پہلے اس دکان کی <bdi dir="ltr">2</bdi> یا زیادہ ڈیلیوریز لینے سے ' +
        'انکار کر چکے ہیں، ڈیلیوری چارجز ایڈوانس بینک ٹرانسفر سے ادا کریں۔',
    );
    // New customers, and by risk: the rule said, the page looking nobody up, and nothing taken
    // off before the order is placed.
    const fresh: CodAdvanceValue = { ...cities, cities: [], newCustomers: true };
    expect(page(fresh, 'Quetta')).toContain(
      'Cash on delivery: you pay when your order arrives. If no order from this shop has ' +
        'reached you before, you pay Rs 500 in advance by bank transfer.',
    );
    expect(page(fresh, 'Quetta')).not.toContain('Advance by bank transfer');
    expect(page(fresh).replace(/\s+/g, ' ')).toContain(
      'اگر اس دکان کا کوئی آرڈر پہلے آپ تک نہیں پہنچا، <bdi dir="ltr">Rs 500</bdi> ایڈوانس بینک ' +
        'ٹرانسفر سے ادا کریں۔',
    );
    const risky: CodAdvanceValue = { ...cities, cities: ['Quetta'], riskScore: 60 };
    expect(page(risky, 'Quetta')).toContain(
      'On orders to Quetta, if the shop&#39;s checks on your order call for it, you pay Rs 500 ' +
        'in advance by bank transfer.',
    );
    expect(page(risky, 'Quetta')).not.toContain('Advance by bank transfer');
    expect(page(risky).replace(/\s+/g, ' ')).toContain(
      'کوئٹہ کے آرڈرز پر، اگر دکان کی جانچ کے مطابق آپ کے آرڈر پر یہ ضروری ہو، ' +
        '<bdi dir="ltr">Rs 500</bdi> ایڈوانس بینک ٹرانسفر سے ادا کریں۔',
    );
    // Nothing said for items at or below its total, wherever it is asked.
    expect(page({ ...cities, above: 4_000_00n })).toContain(
      'Cash on delivery: you pay when your order arrives.',
    );
    expect(page({ ...cities, above: 4_000_00n })).not.toContain('in advance');
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
    // Its Raast ID, as people write numbers, to copy into a banking app.
    expect(page.html).toMatch(
      /Raast ID<\/span>[\s\S]*?<bdi dir="ltr" class="select-all">0300 1234567<\/bdi>/,
    );
    expect(
      checkoutPage({
        kind: 'placed',
        shop: SHOP,
        order: { ...transfer, bankAccount: { ...ACCOUNT, raastId: null } },
      }).html,
    ).not.toContain('Raast ID');
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

  it('shows the badges the shop chose under its button, each where it holds', () => {
    const badges = [
      { kind: 'cash_on_delivery', days: null },
      { kind: 'exchange', days: 7 },
      { kind: 'original', days: null },
      { kind: 'whatsapp', days: null },
    ] as const;
    const shop = { ...SHOP, badges, whatsapp: '+923001234567' };
    const page = checkoutPage(openView({ shop })).html;
    const list = /<ul class="badges stack">([\s\S]*?)<\/ul>/.exec(page)![1]!;
    // In the shop's order, under the button, in English and Urdu.
    expect(page.indexOf('<ul class="badges')).toBeGreaterThan(page.indexOf('</form>'));
    expect(list.match(/<span lang="en">[^<]*/g)).toEqual([
      '<span lang="en">Cash on delivery',
      '<span lang="en">7-day exchange',
      '<span lang="en">100% original products',
      '<span lang="en">Help on WhatsApp',
    ]);
    expect(list).toContain('<span lang="ur" dir="rtl"><bdi dir="ltr">7</bdi> دن میں تبدیلی</span>');
    expect(list).toContain('<a href="https://wa.me/923001234567" target="_blank" rel="noopener"');
    // An exchange links to the refund policy, where the shop has one.
    expect(list).not.toContain('refund-policy');
    const withPolicy = checkoutPage(
      openView({ shop: { ...shop, policies: [{ type: 'refund_policy', versionId: 'v1' }] } }),
    ).html;
    expect(withPolicy).toMatch(
      /<li><a href="https:\/\/zari\.hatti\.test\/policies\/refund-policy" target="_blank" rel="noopener"><span class="both"\s*><span lang="en">7-day exchange/,
    );
    // Cash on delivery only where the page offers it for the cart; WhatsApp only with a number.
    const transferOnly = checkoutPage(
      openView({
        shop: { ...shop, whatsapp: null },
        payments: {
          codRefusal: { reason: 'law' },
          codRules: NO_COD_RULES,
          bankTransfer: ACCOUNT,
          transferDiscount: null,
          advance: null,
        },
      }),
    ).html;
    expect(transferOnly).not.toContain('Cash on delivery</span>');
    expect(transferOnly).not.toContain('Help on WhatsApp');
    expect(transferOnly).toContain('7-day exchange');
    // None to show, no list.
    expect(checkoutPage(openView()).html).not.toContain('class="badges');
    expect(
      checkoutPage(openView({ shop: { ...SHOP, badges: [{ kind: 'whatsapp', days: null }] } }))
        .html,
    ).not.toContain('class="badges');
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

  it("shows the shop's logo in place of its name, the page allowing that image alone", () => {
    const logo =
      'https://hatti.test/storage/shops/s1/files/f1/Zari.png?expires=1790000000&signature=abc';
    const branded = { ...SHOP, name: 'Zari "Fashions"', logo };
    const pages = [
      checkoutPage(openView({ shop: branded })),
      checkoutPage({ kind: 'placed', shop: branded, order: ORDER }),
      checkoutPage({ kind: 'expired', shop: branded }),
      checkoutPage({ kind: 'empty', shop: branded }),
    ];
    for (const page of pages) {
      expect(page.html).toContain(
        '<p class="shop"><img class="logo" ' +
          'src="https://hatti.test/storage/shops/s1/files/f1/Zari.png?expires=1790000000&amp;signature=abc" ' +
          'alt="Zari &quot;Fashions&quot;" /></p>',
      );
      expect(page.contentSecurityPolicy).toContain(
        '; img-src https://hatti.test/storage/shops/s1/files/f1/Zari.png;',
      );
    }
    // Without one, its name; and no images at all.
    const plain = checkoutPage(openView());
    expect(plain.html).toContain('<p class="shop"><bdi>Zari</bdi></p>');
    expect(plain.contentSecurityPolicy).not.toContain('img-src');
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

  it('says what of its total is sales tax, as the order placed keeps it (ADR-096)', () => {
    const tax = { rate: 1_800, taxDelivery: false, updatedAt: null };
    const inKarachi = { ...EMPTY_FORM, city: 'khi' };
    // Not until the total is known, with the city.
    expect(checkoutPage(openView({ tax })).html).not.toContain('Sales tax');
    // Rs 4,000 of kurtas include Rs 610.17 at 18%; delivery's charge none, by default.
    expect(checkoutPage(openView({ tax, form: inKarachi })).html).toMatch(
      /Pay on delivery<\/span>[\s\S]*?Rs 4,150[\s\S]*?Sales tax 18% \(included\)<\/span>[\s\S]*?Rs 610.17/,
    );
    // And its Rs 150 includes Rs 22.88 where the shop's charges include it.
    const withDelivery = checkoutPage(
      openView({ tax: { ...tax, taxDelivery: true }, form: inKarachi }),
    ).html;
    expect(withDelivery).toContain('Rs 633.05');
    // A shop that charges none says nothing of it.
    expect(checkoutPage(openView({ form: inKarachi })).html).not.toContain('Sales tax');
    // The order placed says what it kept.
    const placed = checkoutPage({
      kind: 'placed',
      shop: SHOP,
      order: {
        ...ORDER,
        taxRate: 1_800,
        totalTax: 610_17n,
        lines: [{ ...ORDER.lines[0]!, taxRate: 1_800, tax: 610_17n }],
      },
    }).html;
    expect(placed).toMatch(
      /Total<\/span>[\s\S]*?Rs 4,150[\s\S]*?Sales tax 18% \(included\)<\/span>[\s\S]*?Rs 610.17/,
    );
  });
});
