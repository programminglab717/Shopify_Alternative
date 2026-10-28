import { describe, expect, it } from 'vitest';
import { HattiAdminApiError } from './client.js';
import { accessTokenFor, approvalOf, authorizeUrl } from './oauth.js';

describe('Installing a public app (DEV-05)', () => {
  it('sends the merchant to the consent page, and checks the state they come back with', () => {
    const url = authorizeUrl({
      adminUrl: 'https://admin.hatti.pk',
      clientId: 'hca_1',
      scopes: ['read_products', 'write_orders'],
      redirectUri: 'https://app.example.pk/callback',
      state: 's1',
      shop: 'shop_1',
    });
    expect(url).toBe(
      'https://admin.hatti.pk/oauth/authorize?client_id=hca_1&scope=read_products%2Cwrite_orders' +
        '&redirect_uri=https%3A%2F%2Fapp.example.pk%2Fcallback&state=s1&shop=shop_1',
    );
    const back = 'https://app.example.pk/callback?code=c1&shop=shop_1&state=s1';
    expect(approvalOf(back, 's1')).toEqual({ code: 'c1', shop: 'shop_1' });
    expect(approvalOf(back, 's2')).toBeNull();
    expect(approvalOf('https://app.example.pk/callback?shop=shop_1&state=s1', 's1')).toBeNull();
  });

  it('trades the code for the token, or says why not', async () => {
    const sent: { url: string; body: unknown }[] = [];
    const answer = (status: number, body: unknown) =>
      (async (url: string | URL | Request, init?: RequestInit) => {
        sent.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        return new Response(JSON.stringify(body), { status });
      }) as typeof fetch;
    const asked = {
      apiUrl: 'https://api.hatti.pk',
      clientId: 'hca_1',
      clientSecret: 'hcs_1',
      code: 'c1',
    };
    expect(
      await accessTokenFor({
        ...asked,
        fetch: answer(200, { access_token: 'hat_1', scope: 'read_products,write_orders' }),
      }),
    ).toEqual({ accessToken: 'hat_1', scopes: ['read_products', 'write_orders'] });
    expect(sent[0]).toEqual({
      url: 'https://api.hatti.pk/admin/oauth/access_token',
      body: { client_id: 'hca_1', client_secret: 'hcs_1', code: 'c1' },
    });
    const refused = accessTokenFor({
      ...asked,
      fetch: answer(400, { error: 'invalid_grant', error_description: 'That code is not good' }),
    });
    await expect(refused).rejects.toThrow(HattiAdminApiError);
    await expect(refused).rejects.toThrow('That code is not good');
  });
});
