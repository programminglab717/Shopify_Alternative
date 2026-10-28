import { randomUUID } from 'node:crypto';

// A client for Hatti's Admin API (DEV-09, ADR-850), for apps and integrations: GraphQL over
// fetch, with a custom app's access token (ADR-395), as Shopify's clients ask Shopify's. A query
// the API throttles is asked again once its bucket holds what it costs, as `extensions.cost`
// says; a mutation carries an idempotency key, the same on each try, so a retry never does its
// work twice; a connection is read a page at a time. It needs nothing but Node's fetch.

/** The Admin API's version this client asks by default. */
export const ADMIN_API_VERSION = '2026-10';

/** What a query cost and what its caller has left, as `extensions.cost` tells. */
export interface QueryCost {
  requestedQueryCost: number;
  actualQueryCost: number | null;
  throttleStatus: { maximumAvailable: number; currentlyAvailable: number; restoreRate: number };
}

/** An error the API answered with. */
export interface AdminApiError {
  message: string;
  path?: (string | number)[];
  extensions?: { code?: string; [key: string]: unknown };
}

export interface AdminApiResponse<T> {
  data: T;
  cost: QueryCost | null;
}

export interface HattiAdminClientOptions {
  /** Where Hatti's API answers: "https://api.hatti.pk". */
  apiUrl: string;
  /** The custom app's Admin API access token. */
  accessToken: string;
  version?: string;
  /** How often a throttled or failed request is tried again; 3 unless said. */
  retries?: number;
  fetch?: typeof fetch;
  /** Waits `ms` milliseconds; for tests. */
  sleep?: (ms: number) => Promise<void>;
}

/** The API refused the request, or answered with errors; `errors` says what. */
export class HattiAdminApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly errors: readonly AdminApiError[] = [],
  ) {
    super(message);
    this.name = 'HattiAdminApiError';
  }
}

/** Statuses worth trying again: rate limited, or the server's own trouble. */
const RETRIED = new Set([429, 500, 502, 503, 504]);

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Whether `query` is a mutation: its first operation's keyword, comments aside. */
export function isMutation(query: string): boolean {
  const text = query.replace(/#[^\n]*/g, '').trim();
  return /^mutation\b/.test(text);
}

export class HattiAdminClient {
  readonly #url: string;
  readonly #fetch: typeof fetch;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #retries: number;

  constructor(private readonly options: HattiAdminClientOptions) {
    if (!options.accessToken) throw new Error('The client needs an Admin API access token');
    const base = new URL(options.apiUrl);
    if (
      base.protocol !== 'https:' &&
      base.hostname !== 'localhost' &&
      base.hostname !== '127.0.0.1'
    ) {
      throw new Error('The Admin API is asked over https');
    }
    this.#url = `${base.origin}/admin/api/${options.version ?? ADMIN_API_VERSION}/graphql`;
    this.#fetch = options.fetch ?? fetch;
    this.#sleep = options.sleep ?? delay;
    this.#retries = options.retries ?? 3;
  }

  /**
   * Asks `query` with `variables`: its data, and what it cost. Throttled, it waits until the
   * bucket holds what it costs, then asks again; the server failing, it asks again after a
   * moment; at most so many times. A mutation carries one idempotency key across its tries,
   * `idempotencyKey` where given.
   */
  async request<T = Record<string, unknown>>(
    query: string,
    variables: Record<string, unknown> = {},
    options: { idempotencyKey?: string } = {},
  ): Promise<AdminApiResponse<T>> {
    const key = isMutation(query) ? (options.idempotencyKey ?? randomUUID()) : null;
    const body = JSON.stringify({ query, variables });
    for (let attempt = 0; ; attempt += 1) {
      const response = await this.#fetch(this.#url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          'x-hatti-access-token': this.options.accessToken,
          ...(key && { 'idempotency-key': key }),
        },
        body,
      });
      if (RETRIED.has(response.status) && attempt < this.#retries) {
        const after = Number(response.headers.get('retry-after'));
        await this.#sleep(Number.isFinite(after) && after > 0 ? after * 1000 : 500 * 2 ** attempt);
        continue;
      }
      const json = (await response.json().catch(() => null)) as {
        data?: T;
        errors?: AdminApiError[];
        extensions?: { cost?: QueryCost };
      } | null;
      if (!json) {
        throw new HattiAdminApiError(`The Admin API answered ${response.status}`, response.status);
      }
      const cost = json.extensions?.cost ?? null;
      const errors = json.errors ?? [];
      const throttled = errors.some((error) => error.extensions?.code === 'THROTTLED');
      if (throttled && cost && attempt < this.#retries) {
        const { currentlyAvailable, restoreRate } = cost.throttleStatus;
        const missing = cost.requestedQueryCost - currentlyAvailable;
        await this.#sleep(Math.ceil((Math.max(missing, 1) / Math.max(restoreRate, 1)) * 1000));
        continue;
      }
      if (errors.length > 0 || !response.ok || json.data === undefined) {
        throw new HattiAdminApiError(
          errors[0]?.message ?? `The Admin API answered ${response.status}`,
          response.status,
          errors,
        );
      }
      return { data: json.data, cost };
    }
  }

  /**
   * Each node of the connection `select` picks from `query`'s data, page after page: the query
   * takes `$after` and asks the connection's `nodes` and `pageInfo { hasNextPage endCursor }`.
   */
  async *paginate<T, D = Record<string, unknown>>(
    query: string,
    variables: Record<string, unknown>,
    select: (data: D) => {
      nodes: readonly T[];
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    },
  ): AsyncGenerator<T> {
    let after: string | null = null;
    for (;;) {
      const { data } = await this.request<D>(query, { ...variables, after });
      const page = select(data);
      yield* page.nodes;
      if (!page.pageInfo.hasNextPage || !page.pageInfo.endCursor) return;
      after = page.pageInfo.endCursor;
    }
  }
}
