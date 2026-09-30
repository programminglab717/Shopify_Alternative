// The edge that keeps storefront pages (ADR-047): the publisher tells it to forget the pages
// tagged with what it has just written.

/** Where storefront pages are kept in front of the storefront. */
export interface EdgeCache {
  /** Forgets every page tagged with any of `tags`. */
  purge(tags: readonly string[]): Promise<void>;
}

/** No edge in front of the storefront, as in development: nothing to forget. */
export const NO_EDGE_CACHE: EdgeCache = { purge: async () => {} };

/** The most tags Cloudflare purges in one call. */
const TAGS_PER_PURGE = 30;

export interface CloudflareCacheOptions {
  /** The zone storefronts are served in. */
  zoneId: string;
  /** An API token that may purge the zone's cache. */
  token: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

/** Cloudflare's cache (ADR-007), purged by tag through its API. */
export class CloudflareCache implements EdgeCache {
  constructor(private readonly options: CloudflareCacheOptions) {}

  async purge(tags: readonly string[]): Promise<void> {
    const unique = [...new Set(tags)];
    const base = this.options.baseUrl ?? 'https://api.cloudflare.com/client/v4';
    const send = this.options.fetch ?? fetch;
    for (let start = 0; start < unique.length; start += TAGS_PER_PURGE) {
      const response = await send(`${base}/zones/${this.options.zoneId}/purge_cache`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.options.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ tags: unique.slice(start, start + TAGS_PER_PURGE) }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        throw new Error(
          `Cloudflare answered ${response.status} to a purge: ${await response.text()}`,
        );
      }
    }
  }
}
