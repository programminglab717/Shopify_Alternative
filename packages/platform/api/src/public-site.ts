/**
 * Where customers reach Hatti's public pages, such as the link a draft order is confirmed
 * through: "https://hatti.pk". Provided by the host application from its configuration.
 */
export class PublicSite {
  /** The base URL, without a trailing slash. */
  readonly baseUrl: string;

  constructor(baseUrl: string) {
    const url = new URL(baseUrl);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new Error(`The public site must be an http(s) URL: ${baseUrl}`);
    }
    this.baseUrl = url.href.replace(/\/+$/, '');
  }

  /** The absolute URL of a path on the site, such as "/d/…". */
  url(path: string): string {
    return `${this.baseUrl}/${path.replace(/^\/+/, '')}`;
  }
}

/**
 * Where shops' storefronts answer: each at its handle's subdomain of the platform's storefront
 * address, "https://zari.hatti.pk" for the shop "zari" when that is "https://hatti.pk". Provided
 * by the host application from its configuration.
 */
export class StorefrontSite {
  readonly #origin: string;

  constructor(baseUrl: string) {
    const url = new URL(baseUrl);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new Error(`Storefronts must be at an http(s) URL: ${baseUrl}`);
    }
    this.#origin = url.origin;
  }

  /** The address of the storefront of the shop with this handle, without a trailing slash. */
  url(handle: string): string {
    const url = new URL(this.#origin);
    url.hostname = `${handle}.${url.hostname}`;
    return url.href.replace(/\/+$/, '');
  }
}
