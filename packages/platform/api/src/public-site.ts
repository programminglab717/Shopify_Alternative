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
