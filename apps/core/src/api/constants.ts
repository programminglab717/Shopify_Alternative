/** Admin API versions are dated, as in Shopify; each stays supported for at least 12 months. */
export const ADMIN_API_VERSION = '2026-10';
export const ADMIN_API_PREFIX = '/admin/api/';
export const ADMIN_GRAPHQL_PATH = `${ADMIN_API_PREFIX}${ADMIN_API_VERSION}/graphql`;

/** Header carrying an Admin API access token. */
export const ACCESS_TOKEN_HEADER = 'x-hatti-access-token';

/** DI tokens for resources created by the process entry point. */
export const REDIS = Symbol('REDIS');
export const LOGGER = Symbol('LOGGER');
