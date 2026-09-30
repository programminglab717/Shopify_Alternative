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
  /** The platform's domain, which storefronts answer under: hatti.pk. */
  readonly domain: string;
  /**
   * Where a shop points a domain of its own, with a CNAME record (ADR-048): shops.hatti.pk,
   * unless the host application says otherwise.
   */
  readonly dnsTarget: string;

  constructor(baseUrl: string, options: { dnsTarget?: string } = {}) {
    const url = new URL(baseUrl);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new Error(`Storefronts must be at an http(s) URL: ${baseUrl}`);
    }
    this.#origin = url.origin;
    this.domain = url.hostname;
    this.dnsTarget = options.dnsTarget ?? `shops.${url.hostname}`;
  }

  /** The address of the storefront of the shop with this handle, without a trailing slash. */
  url(handle: string): string {
    return this.urlAt(`${handle}.${this.domain}`);
  }

  /** The address of a storefront at a domain of its shop's own: https://www.zari.pk. */
  urlAt(host: string): string {
    const url = new URL(this.#origin);
    url.hostname = host;
    return url.href.replace(/\/+$/, '');
  }

  /** Whether `host` is the platform's domain or under it, which no shop can connect as its own. */
  isPlatformHost(host: string): boolean {
    return host === this.domain || host.endsWith(`.${this.domain}`);
  }
}
