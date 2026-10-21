// The admin's way to the core: `/auth` for the account and its session, and the Admin API's
// GraphQL for the shop, both on the admin's own origin (Vite's proxy in development, the edge in
// production). Tokens are opaque bearer tokens in JSON bodies, never cookies (ADR-265).

import { DEVICE_HEADER, deviceId } from './device';

/** The Admin API's GraphQL endpoint, by version (apps/core/src/api/constants.ts). */
export const ADMIN_GRAPHQL_PATH = '/admin/api/2026-10/graphql';

/** The header naming the shop a staff request is for. */
export const SHOP_HEADER = 'x-hatti-shop-id';

/** A field the API found wrong, with its words. */
export interface FieldError {
  field: readonly string[];
  code: string;
  message: string;
}

/**
 * Something the API refused, or could not be reached: its HTTP status (0 when it could not be
 * reached), its code, such as `INVALID_CODE` or `MFA_REQUIRED`, and its words.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fields: readonly FieldError[] = [],
    /** Seconds to wait before trying again, from a 429's Retry-After or a throttled query. */
    readonly retryAfter: number | null = null,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** The fetch the client uses: the browser's, or a test's. */
export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** The browser's fetch, called as the browser needs it to be (on the window, not detached). */
export const browserFetch: Fetch = (input, init) => fetch(input, init);

async function bodyOf(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/**
 * The fields `/auth` found wrong, which it names as `{ "password": "Too short" }`; a list as
 * GraphQL's `userErrors` give them is taken as it is.
 */
function fieldsOf(fields: unknown): FieldError[] {
  if (Array.isArray(fields)) return fields as FieldError[];
  if (!fields || typeof fields !== 'object') return [];
  return Object.entries(fields as Record<string, unknown>).map(([field, message]) => ({
    field: [field],
    code: 'INVALID',
    message: String(message),
  }));
}

async function send(fetcher: Fetch, path: string, init: RequestInit): Promise<Response> {
  try {
    return await fetcher(path, init);
  } catch {
    throw new ApiError(0, 'NETWORK', 'The network could not be reached');
  }
}

/**
 * A call to `/auth`: its JSON answer, or an {@link ApiError} from the body the identity module
 * gives, `{ error: { code, message, fields? } }`. It carries this browser's device ID, which
 * tells a sign-in from it from one elsewhere (ADR-681).
 */
export async function authRequest<T>(
  fetcher: Fetch,
  path: string,
  options: { method?: 'GET' | 'POST' | 'DELETE'; body?: unknown; accessToken?: string } = {},
): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.accessToken) headers.authorization = `Bearer ${options.accessToken}`;
  const device = deviceId();
  if (device) headers[DEVICE_HEADER] = device;
  const response = await send(fetcher, path, {
    method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const body = await bodyOf(response);
  if (response.ok) return body as T;
  const error = (body as { error?: { code?: string; message?: string; fields?: unknown } })?.error;
  const retryAfter = Number(response.headers.get('retry-after'));
  throw new ApiError(
    response.status,
    error?.code ?? `HTTP_${response.status}`,
    error?.message ?? response.statusText,
    fieldsOf(error?.fields),
    Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
  );
}

/** What a query cost and what the shop's bucket holds (ADR-576), on every Admin API answer. */
export interface QueryCost {
  requestedQueryCost: number;
  actualQueryCost?: number | null;
  throttleStatus: { maximumAvailable: number; currentlyAvailable: number; restoreRate: number };
}

interface GraphQLResponse<T> {
  data?: T | null;
  errors?: { message: string; extensions?: { code?: string } }[];
  extensions?: { cost?: QueryCost };
}

/** How many times a throttled request is sent again before the admin gives up (ADR-577). */
export const THROTTLE_RETRIES = 3;

/** The longest the admin waits for the bucket before sending a throttled request again. */
export const THROTTLE_MAX_WAIT_SECONDS = 30;

/** The words for a request still throttled after {@link THROTTLE_RETRIES} more tries. */
const THROTTLED_MESSAGE = 'Hatti is busy for this shop right now; try again in a moment';

/**
 * Seconds until the bucket holds what a throttled query asked for: the points it lacks over the
 * points restored each second, rounded up, from one second to {@link THROTTLE_MAX_WAIT_SECONDS}.
 */
export function throttleWait(cost: QueryCost | undefined): number {
  const status = cost?.throttleStatus;
  const lacking = Number(cost?.requestedQueryCost) - Number(status?.currentlyAvailable);
  const rate = Number(status?.restoreRate);
  if (!Number.isFinite(lacking) || !Number.isFinite(rate)) return 1;
  const seconds = rate > 0 ? Math.ceil(lacking / rate) : THROTTLE_MAX_WAIT_SECONDS;
  return Math.min(THROTTLE_MAX_WAIT_SECONDS, Math.max(1, seconds));
}

/**
 * Whether `error` is the Admin API refusing a query for its cost (ADR-576): throttled, which the
 * client already waited out and tried again, or too costly ever to run. Neither is worth another
 * try from the caller.
 */
export function isCostRefusal(error: unknown): boolean {
  return (
    error instanceof ApiError && (error.code === 'THROTTLED' || error.code === 'MAX_COST_EXCEEDED')
  );
}

// The requests waiting for the bucket to refill, each with when its wait ends, for the notice the
// admin shows meanwhile.
const waiting = new Map<symbol, number>();
const waitWatchers = new Set<() => void>();

function changed(): void {
  for (const watcher of waitWatchers) watcher();
}

/** When the last request waiting for the bucket sends again (epoch ms), or null when none waits. */
export function busyUntil(): number | null {
  return waiting.size ? Math.max(...waiting.values()) : null;
}

/** Calls `watcher` whenever a request starts or stops waiting for the bucket; returns the undo. */
export function watchBusy(watcher: () => void): () => void {
  waitWatchers.add(watcher);
  return () => void waitWatchers.delete(watcher);
}

async function waitForBucket(seconds: number): Promise<void> {
  const wait = Symbol('wait');
  waiting.set(wait, Date.now() + seconds * 1000);
  changed();
  try {
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  } finally {
    waiting.delete(wait);
    changed();
  }
}

/**
 * One GraphQL request to the Admin API for `shopId`, as staff signed in with `accessToken`. A
 * refusal before GraphQL runs (401, `MFA_REQUIRED`, `NO_SHOP_ACCESS`…) and a GraphQL error both
 * become an {@link ApiError} with its code; `userErrors` stay in the data for the screen.
 *
 * A request the shop's bucket cannot pay for yet (`THROTTLED`) ran nothing and took nothing, so
 * it is sent again, as it was and with its Idempotency-Key, once the bucket holds enough: up to
 * {@link THROTTLE_RETRIES} times, and then it fails as `THROTTLED` (ADR-577). One too costly ever
 * to run (`MAX_COST_EXCEEDED`) fails at once.
 */
export async function graphqlRequest<T>(
  fetcher: Fetch,
  document: string,
  variables: Record<string, unknown> | undefined,
  options: { accessToken: string; shopId: string; idempotencyKey?: string },
): Promise<T> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    'content-type': 'application/json',
    authorization: `Bearer ${options.accessToken}`,
    [SHOP_HEADER]: options.shopId,
  };
  if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;
  const body = JSON.stringify({ query: document, variables });
  for (let tries = 0; ; tries++) {
    const response = await send(fetcher, ADMIN_GRAPHQL_PATH, { method: 'POST', headers, body });
    const answer = (await bodyOf(response)) as GraphQLResponse<T> | null;
    const first = answer?.errors?.[0];
    if (first?.extensions?.code === 'THROTTLED') {
      const wait = throttleWait(answer?.extensions?.cost);
      if (tries >= THROTTLE_RETRIES) {
        throw new ApiError(response.status, 'THROTTLED', THROTTLED_MESSAGE, [], wait);
      }
      await waitForBucket(wait);
      continue;
    }
    if (first) {
      throw new ApiError(response.status, first.extensions?.code ?? 'GRAPHQL', first.message);
    }
    if (!response.ok || !answer?.data) {
      throw new ApiError(response.status, `HTTP_${response.status}`, response.statusText);
    }
    return answer.data;
  }
}
