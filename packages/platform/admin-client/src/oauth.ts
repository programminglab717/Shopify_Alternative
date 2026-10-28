import { HattiAdminApiError } from './client.js';

// A public app's install (DEV-05, ADR-851), as Shopify's apps are installed: the app sends the
// merchant to the admin's consent page with `authorizeUrl`; approved, the merchant comes back to
// its redirect URL with `code`, `shop` and `state`, the state checked against the one it sent;
// it then trades the code for the shop's token with `accessTokenFor`, within ten minutes, once.

export interface AuthorizeUrlOptions {
  /** Where Hatti's admin answers: "https://admin.hatti.pk". */
  adminUrl: string;
  clientId: string;
  scopes: readonly string[];
  /** One of the app's registered redirect URLs, exactly. */
  redirectUri: string;
  /** A value of the app's own, unguessable, to check when the merchant comes back. */
  state: string;
  /** The shop, where the app knows it already: the merchant may still pick another. */
  shop?: string;
}

/** The consent page to send the merchant to. */
export function authorizeUrl(options: AuthorizeUrlOptions): string {
  const url = new URL('/oauth/authorize', options.adminUrl);
  url.searchParams.set('client_id', options.clientId);
  url.searchParams.set('scope', options.scopes.join(','));
  url.searchParams.set('redirect_uri', options.redirectUri);
  url.searchParams.set('state', options.state);
  if (options.shop) url.searchParams.set('shop', options.shop);
  return url.toString();
}

/** What the merchant's return to the redirect URL says, its state checked: null if not good. */
export function approvalOf(
  returned: URL | string,
  expectedState: string,
): { code: string; shop: string } | null {
  const params = new URL(returned).searchParams;
  const code = params.get('code');
  const shop = params.get('shop');
  if (!code || !shop || !expectedState || params.get('state') !== expectedState) return null;
  return { code, shop };
}

/** Trades an approval's code for the shop's Admin API token, and the scopes approved. */
export async function accessTokenFor(options: {
  /** Where Hatti's API answers: "https://api.hatti.pk". */
  apiUrl: string;
  clientId: string;
  clientSecret: string;
  code: string;
  fetch?: typeof fetch;
}): Promise<{ accessToken: string; scopes: string[] }> {
  const response = await (options.fetch ?? fetch)(
    new URL('/admin/oauth/access_token', options.apiUrl).toString(),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        client_id: options.clientId,
        client_secret: options.clientSecret,
        code: options.code,
      }),
    },
  );
  const body = (await response.json().catch(() => null)) as {
    access_token?: string;
    scope?: string;
    error_description?: string;
  } | null;
  if (!response.ok || !body?.access_token) {
    throw new HattiAdminApiError(
      body?.error_description ?? `The Admin API answered ${response.status}`,
      response.status,
    );
  }
  return {
    accessToken: body.access_token,
    scopes: (body.scope ?? '').split(',').filter(Boolean),
  };
}
