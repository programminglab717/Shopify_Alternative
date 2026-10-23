/** A store's name at Shopify: what comes before .myshopify.com. */
const STORE_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * A Shopify store's own address, `{name}.myshopify.com`, from what its owner typed: the store's
 * name, that address, a link to it, or a link to its admin at admin.shopify.com/store/{name}; null
 * for anything else. Only Shopify's own addresses are ever asked, so a store's credentials go to
 * no other host.
 */
export function shopDomainOf(input: string): string | null {
  let text = input.trim().toLowerCase();
  if (text === '') return null;
  if (!/^[a-z]+:\/\//.test(text)) text = `https://${text}`;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username !== '' || url.password !== '' || url.port !== '') return null;
  const host = url.hostname;
  if (host === 'admin.shopify.com') {
    const [, store, name] = url.pathname.split('/');
    return store === 'store' && name && STORE_NAME.test(name) ? `${name}.myshopify.com` : null;
  }
  if (host.endsWith('.myshopify.com')) {
    const name = host.slice(0, -'.myshopify.com'.length);
    return STORE_NAME.test(name) ? host : null;
  }
  return !host.includes('.') && STORE_NAME.test(host) && url.pathname === '/'
    ? `${host}.myshopify.com`
    : null;
}
