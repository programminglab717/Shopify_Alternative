import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DarazClient, DarazError, darazSignature, priceQuantityPayload } from './daraz-client.js';

/** A fake Open Platform answering `body` to every call, each call's URL and form kept. */
function platform(body: unknown, status = 200) {
  const calls: { url: string; form: URLSearchParams | null }[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      form: init?.body ? new URLSearchParams(String(init.body)) : null,
    });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof globalThis.fetch;
  const client = new DarazClient({
    appKey: '501234',
    appSecret: 'the-app-secret-of-daraz',
    apiUrl: 'https://api.daraz.example/rest',
    authUrl: 'https://auth.daraz.example/rest',
    authorizeUrl: 'https://api.daraz.example/oauth/authorize',
    fetch,
  });
  return { client, calls };
}

describe("Daraz's Open Platform, as Hatti calls it (CH-06, ADR-875)", () => {
  it('signs a call by its path and its parameters sorted by name, in upper-case hex', () => {
    const expected = createHmac('sha256', 'secret')
      .update('/orders/geta2bapp_key1sign_methodsha256timestamp9')
      .digest('hex')
      .toUpperCase();
    expect(
      darazSignature('secret', '/orders/get', {
        timestamp: '9',
        sign_method: 'sha256',
        app_key: '1',
        a: '2b',
      }),
    ).toBe(expected);
  });

  it("gives Daraz SKUs' stock and prices as its XML, what a shop wrote escaped", () => {
    expect(
      priceQuantityPayload([
        { sku: 'LS-M', quantity: 3, price: '3000.00' },
        { sku: 'A&B<1>', quantity: 0 },
      ]),
    ).toBe(
      '<?xml version="1.0" encoding="UTF-8" ?><Request><Product><Skus>' +
        '<Sku><SellerSku>LS-M</SellerSku><Quantity>3</Quantity><Price>3000.00</Price></Sku>' +
        '<Sku><SellerSku>A&#38;B&#60;1&#62;</SellerSku><Quantity>0</Quantity></Sku>' +
        '</Skus></Product></Request>',
    );
  });

  it("reads a seller's orders, signed with their token, and their tokens from a code", async () => {
    const { client, calls } = platform({
      code: '0',
      data: {
        orders: [
          {
            order_id: 1001,
            statuses: ['pending'],
            created_at: '2026-10-28 10:00:00 +0500',
            address_shipping: {
              first_name: 'Ayesha',
              last_name: 'Khan',
              phone: '923001234567',
              address1: 'House 12, Street 4',
              city: 'Lahore',
            },
          },
        ],
      },
    });
    const [order] = await client.orders('seller-token', new Date('2026-10-28T00:00:00Z'));
    expect(order).toEqual({
      orderId: '1001',
      status: 'pending',
      createdAt: '2026-10-28 10:00:00 +0500',
      address: {
        name: 'Ayesha Khan',
        phone: '923001234567',
        address1: 'House 12, Street 4',
        address2: null,
        city: 'Lahore',
      },
    });
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe('/rest/orders/get');
    const params = Object.fromEntries(url.searchParams);
    expect(params).toMatchObject({
      app_key: '501234',
      access_token: 'seller-token',
      sign_method: 'sha256',
      update_after: '2026-10-28T00:00:00+00:00',
    });
    const { sign, ...rest } = params;
    expect(sign).toBe(darazSignature('the-app-secret-of-daraz', '/orders/get', rest));

    const tokens = platform({
      access_token: 'access',
      refresh_token: 'refresh',
      expires_in: 3600,
      refresh_expires_in: 7200,
      account: 'zari@daraz.pk',
      country_user_info: [{ seller_id: '1234567' }],
    });
    const now = new Date('2026-10-28T00:00:00Z');
    expect(await tokens.client.createToken('the-code', now)).toEqual({
      accessToken: 'access',
      refreshToken: 'refresh',
      accessExpiresAt: new Date('2026-10-28T01:00:00Z'),
      refreshExpiresAt: new Date('2026-10-28T02:00:00Z'),
      account: 'zari@daraz.pk',
      sellerId: '1234567',
    });
    expect(tokens.calls[0]!.url).toBe('https://auth.daraz.example/rest/auth/token/create');
    expect(tokens.calls[0]!.form?.get('code')).toBe('the-code');
  });

  it('says which SKUs Daraz refused, and fails on anything else it refuses', async () => {
    const refused = platform({
      code: '500',
      message: 'Some SKUs failed',
      detail: [{ seller_sku: 'GONE', message: 'SellerSku not found' }],
    });
    expect(
      await refused.client.updatePriceQuantity('token', [{ sku: 'GONE', quantity: 1 }]),
    ).toEqual([{ sku: 'GONE', error: 'SellerSku not found' }]);
    const down = platform({ code: 'IllegalAccessToken', message: 'The token is invalid' });
    await expect(down.client.orders('old', new Date())).rejects.toEqual(
      new DarazError('IllegalAccessToken', 'The token is invalid'),
    );
  });
});
