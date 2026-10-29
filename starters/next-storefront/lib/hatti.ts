// The shop's Storefront API (ADR-848): GraphQL at its storefront, answered with the shop's public
// token, as Shopify's Storefront API is. Catalog answers are kept a minute by Next's data cache;
// carts and accounts are never kept. Sign-ins go with the private token where it is set, naming
// the shopper's address, so that the API counts each shopper's, not this server's (ADR-943).

export interface StorefrontAnswer<T> {
  data?: T;
  errors?: { message: string }[];
}

export class StorefrontError extends Error {
  override readonly name = 'StorefrontError';
}

function settings() {
  const domain = process.env.HATTI_STORE_DOMAIN;
  const token = process.env.HATTI_STOREFRONT_TOKEN;
  if (!domain || !token) {
    throw new StorefrontError(
      'Set HATTI_STORE_DOMAIN and HATTI_STOREFRONT_TOKEN: see .env.example',
    );
  }
  return {
    domain,
    token,
    privateToken: process.env.HATTI_STOREFRONT_PRIVATE_TOKEN || null,
    version: process.env.HATTI_API_VERSION ?? '2025-01',
  };
}

/** Asks the Storefront API `query`: its data, or an error saying what went wrong. */
export async function storefront<T>(
  query: string,
  variables: Record<string, unknown> = {},
  options: { cache?: 'minute' | 'none'; buyerIp?: string | null } = {},
): Promise<T> {
  const { domain, token, privateToken, version } = settings();
  const buyer = privateToken && options.buyerIp ? options.buyerIp : null;
  const response = await fetch(`https://${domain}/api/${version}/graphql.json`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(buyer && privateToken
        ? {
            'shopify-storefront-private-token': privateToken,
            'shopify-storefront-buyer-ip': buyer,
          }
        : { 'x-shopify-storefront-access-token': token }),
    },
    body: JSON.stringify({ query, variables }),
    ...(options.cache === 'none' ? { cache: 'no-store' } : { next: { revalidate: 60 } }),
  });
  if (!response.ok) throw new StorefrontError(`The Storefront API answered ${response.status}`);
  const answer = (await response.json()) as StorefrontAnswer<T>;
  if (answer.errors?.length) throw new StorefrontError(answer.errors[0]!.message);
  if (!answer.data) throw new StorefrontError('The Storefront API gave no data');
  return answer.data;
}
