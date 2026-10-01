import { describe, expect, it } from 'vitest';
import { cartBody, cartCookies, cartRoute, cookieOf, parseForm, permalinkItems } from './cart.js';

describe('Cart requests', () => {
  it('reads forms as Rails and Shopify do, and nothing that reaches prototypes', () => {
    expect(
      parseForm(
        'items[][id]=v1&items[][quantity]=2&items[][id]=v2&properties[Gift+note]=Eid+Mubarak' +
          '&updates[]=1&updates[]=0&__proto__[polluted]=1&a[constructor][prototype]=1',
      ),
    ).toEqual({
      items: [{ id: 'v1', quantity: '2' }, { id: 'v2' }],
      properties: { 'Gift note': 'Eid Mubarak' },
      updates: ['1', '0'],
      a: {},
    });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    // Numbered items, in their numbers' order.
    expect(cartBody('add', parseForm('items[1][id]=v2&items[0][id]=v1')).body).toEqual({
      items: [
        { variantId: 'v1', quantity: 1, properties: {} },
        { variantId: 'v2', quantity: 1, properties: {} },
      ],
    });
  });

  it("turns Shopify's parameters into the core's actions", () => {
    expect(cartBody('add', parseForm('id=v1&quantity=3&properties[Name]=Sana'))).toEqual({
      body: { items: [{ variantId: 'v1', quantity: 3, properties: { Name: 'Sana' } }] },
      single: true,
    });
    // What the storefront cannot read goes to the core as it is, which refuses it.
    expect(cartBody('add', { id: 'v1', quantity: 'many' }).body).toEqual({
      items: [{ variantId: 'v1', quantity: 'many', properties: {} }],
    });
    expect(cartBody('change', { line: '2', quantity: '0' }).body).toEqual({
      line: { index: 2 },
      quantity: 0,
    });
    expect(cartBody('change', { id: 'v1:abc', properties: { Size: 38 } }).body).toEqual({
      line: { key: 'v1:abc' },
      properties: { Size: '38' },
    });
    expect(cartBody('update', { attributes: { Gift: true }, note: 'Call' }).body).toEqual({
      attributes: { Gift: 'true' },
      note: 'Call',
    });
    // Shopify's discount codes, from the cart form or a script: the core picks the code.
    expect(cartBody('update', parseForm('discount=EID10%2CFREESHIP')).body).toEqual({
      discount: 'EID10,FREESHIP',
    });
    expect(cartBody('clear', { anything: 1 }).body).toEqual({});
  });

  it("knows Shopify's cart paths and the cart's cookies", () => {
    expect(cartRoute('/cart')).toEqual({ action: 'show', json: false });
    expect(cartRoute('/cart.js')).toEqual({ action: 'show', json: true });
    expect(cartRoute('/cart/change.js')).toEqual({ action: 'change', json: true });
    expect(cartRoute('/cart/add/')).toEqual({ action: 'add', json: false });
    expect(cartRoute('/cart/checkout')).toBeNull();
    // Shopify's cart permalinks, which are no cart route.
    const [v1, v2] = [
      '01a0eb82-13de-72f6-96fc-6fd63137a7d5',
      '01a0eb82-13de-72f6-96fc-6fd63137a7d6',
    ];
    expect(cartRoute(`/cart/${v1}:2`)).toBeNull();
    expect(permalinkItems(`/cart/${v1}:2,${v2}:1`)).toEqual([
      { variantId: v1, quantity: 2, properties: {} },
      { variantId: v2, quantity: 1, properties: {} },
    ]);
    expect(permalinkItems(`/cart/${v1}%3A3%2C${v2}%3A1/`)).toHaveLength(2);
    for (const path of [
      '/cart',
      '/cart/add',
      `/cart/${v1}`,
      `/cart/${v1}:x`,
      `/cart/${v1}:1,`,
      '/cart/%E0',
    ]) {
      expect(permalinkItems(path), path).toBeNull();
    }
    expect(cookieOf('a=1; cart=secret; cart_count=2', 'cart')).toBe('secret');
    expect(cookieOf('cart_count=2', 'cart')).toBeNull();
    expect(cartCookies('secret', 3, { secure: true })).toEqual([
      'cart=secret; Max-Age=1209600; Path=/; SameSite=Lax; Secure; HttpOnly',
      'cart_count=3; Max-Age=1209600; Path=/; SameSite=Lax; Secure',
    ]);
  });
});
