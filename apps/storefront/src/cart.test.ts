import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { addAgain } from './accounts.js';
import {
  cartBody,
  cartCookies,
  cartErrorMessage,
  cartRoute,
  cookieOf,
  parseForm,
  parseMultipartForm,
  permalinkItems,
} from './cart.js';
import { sampleStore } from './fixtures.js';
import { shopObject } from './objects.js';

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

  it("reads a script's FormData as it reads a form, counting the files it carries (ADR-701)", async () => {
    const data = new FormData();
    data.append('items[][id]', 'v1');
    data.append('items[][quantity]', '2');
    data.append('properties[Gift note]', 'Eid Mubarak');
    data.append('__proto__[polluted]', '1');
    data.append('empty', new Blob([]), '');
    const request = new Request('http://localhost/', { method: 'POST', body: data });
    const type = request.headers.get('content-type')!;
    const body = Buffer.from(await request.arrayBuffer());
    expect(await parseMultipartForm(type, body)).toEqual({
      params: {
        items: [{ id: 'v1', quantity: '2' }],
        properties: { 'Gift note': 'Eid Mubarak' },
        empty: '',
      },
      files: 0,
    });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();

    data.append('properties[Photo]', new Blob(['jpeg'], { type: 'image/jpeg' }), 'me.jpg');
    const withFile = new Request('http://localhost/', { method: 'POST', body: data });
    expect(
      await parseMultipartForm(
        withFile.headers.get('content-type')!,
        Buffer.from(await withFile.arrayBuffer()),
      ),
    ).toMatchObject({ files: 1 });
    // An empty file input as a browser sends it: a file of nothing, without a name.
    const empty =
      '--x\r\nContent-Disposition: form-data; name="properties[Photo]"; filename=""\r\n' +
      'Content-Type: application/octet-stream\r\n\r\n\r\n--x--\r\n';
    expect(await parseMultipartForm('multipart/form-data; boundary=x', Buffer.from(empty))).toEqual(
      { params: { properties: { Photo: '' } }, files: 0 },
    );
    await expect(
      parseMultipartForm('multipart/form-data; boundary=x', Buffer.from('id=1')),
    ).rejects.toThrow();
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
    // A plan chosen in a product's form, as Shopify's selling_plan (ADR-862).
    expect(
      cartBody('add', parseForm('id=v1&selling_plan=slpl_1&properties[Name]=Sana')).body,
    ).toEqual({
      items: [
        { variantId: 'v1', quantity: 1, properties: { Name: 'Sana', _selling_plan: 'slpl_1' } },
      ],
    });
    expect(cartBody('add', parseForm('id=v1&selling_plan=')).body).toEqual({
      items: [{ variantId: 'v1', quantity: 1, properties: {} }],
    });
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

  it("says prices include any sales tax, as Pakistan's consumer laws ask them to be shown", () => {
    expect(shopObject(sampleStore().shop).taxes_included).toBe(true);
  });

  it("says what a product made to order still asks for, in the theme's words (ADR-691)", () => {
    const urdu = JSON.parse(
      readFileSync(new URL('../../../themes/hatti-base/locales/ur.json', import.meta.url), 'utf8'),
    ) as { cart: { errors: Record<string, string> } };
    const inUrdu = (key: string, values: Record<string, unknown>) => {
      const words = urdu.cart.errors[key.replace('cart.errors.', '')];
      return words?.replace(/\{\{ (\w+) \}\}/g, (_, name: string) => String(values[name])) ?? null;
    };
    const refused = (problem: 'missing' | 'too_long' | 'not_a_choice') =>
      ({
        code: 'PERSONALISATION',
        variantId: 'v',
        title: 'Kurta',
        field: 'Name',
        problem,
      }) as const;
    expect(cartErrorMessage(refused('missing'), () => null)).toBe('Please fill in Name for Kurta.');
    expect(cartErrorMessage(refused('too_long'), () => null)).toBe('Name for Kurta is too long.');
    expect(cartErrorMessage(refused('not_a_choice'), () => null)).toBe(
      'Please choose Name for Kurta from its list.',
    );
    expect(cartErrorMessage(refused('missing'), inUrdu)).toBe('براہ کرم Kurta کے لیے Name لکھیں۔');
  });

  it('buys again without what a product now asks for, the rest going in (ADR-691)', async () => {
    const asked: string[][] = [];
    const items = [
      { variantId: 'kurta', quantity: 1, properties: {} },
      { variantId: 'lawn', quantity: 2, properties: {} },
    ];
    const result = await addAgain(
      items,
      async (left) => {
        asked.push(left.map((item) => item.variantId));
        return left.some((item) => item.variantId === 'kurta')
          ? {
              ok: false,
              error: {
                code: 'PERSONALISATION',
                variantId: 'kurta',
                title: 'Kurta',
                field: 'Name',
                problem: 'missing',
              },
            }
          : ({ ok: true } as never);
      },
      async () => 0,
    );
    expect(asked).toEqual([['kurta', 'lawn'], ['lawn']]);
    expect(result).toEqual({ added: { ok: true }, short: true });
  });
});
