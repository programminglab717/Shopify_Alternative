/** Admin API versions are dated, as in Shopify; each stays supported for at least 12 months. */
export const ADMIN_API_VERSION = '2026-10';
export const ADMIN_API_PREFIX = '/admin/api/';
export const ADMIN_GRAPHQL_PATH = `${ADMIN_API_PREFIX}${ADMIN_API_VERSION}/graphql`;

/** Header carrying an app's Admin API access token. */
export const ACCESS_TOKEN_HEADER = 'x-hatti-access-token';
/** Header naming the shop a staff request is for (staff can belong to several). */
export const SHOP_HEADER = 'x-hatti-shop-id';
/** Header with a caller's key for one intent, so that a retry cannot do the work twice. */
export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';

/** DI tokens for resources created by the process entry point. */
export const REDIS = Symbol('REDIS');
export const LOGGER = Symbol('LOGGER');
