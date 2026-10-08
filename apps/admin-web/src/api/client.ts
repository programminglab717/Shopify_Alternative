// The admin's way to the core: `/auth` for the account and its session, and the Admin API's
// GraphQL for the shop, both on the admin's own origin (Vite's proxy in development, the edge in
// production). Tokens are opaque bearer tokens in JSON bodies, never cookies (ADR-265).

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
    /** Seconds to wait before trying again, from a 429's Retry-After. */
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
 * gives, `{ error: { code, message, fields? } }`.
 */
export async function authRequest<T>(
  fetcher: Fetch,
  path: string,
  options: { method?: 'GET' | 'POST' | 'DELETE'; body?: unknown; accessToken?: string } = {},
): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.accessToken) headers.authorization = `Bearer ${options.accessToken}`;
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

interface GraphQLResponse<T> {
  data?: T | null;
  errors?: { message: string; extensions?: { code?: string } }[];
}

/**
 * One GraphQL request to the Admin API for `shopId`, as staff signed in with `accessToken`. A
 * refusal before GraphQL runs (401, `MFA_REQUIRED`, `NO_SHOP_ACCESS`…) and a GraphQL error both
 * become an {@link ApiError} with its code; `userErrors` stay in the data for the screen.
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
  const response = await send(fetcher, ADMIN_GRAPHQL_PATH, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query: document, variables }),
  });
  const body = (await bodyOf(response)) as GraphQLResponse<T> | null;
  const first = body?.errors?.[0];
  if (first) {
    throw new ApiError(response.status, first.extensions?.code ?? 'GRAPHQL', first.message);
  }
  if (!response.ok || !body?.data) {
    throw new ApiError(response.status, `HTTP_${response.status}`, response.statusText);
  }
  return body.data;
}
