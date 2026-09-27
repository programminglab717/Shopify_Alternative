import type { CurrencyCode } from '@hatti/money';

/**
 * Access scopes, named like Shopify's: read_<resource> and write_<resource>.
 * write_<resource> implies read_<resource>.
 */
export const ACCESS_SCOPES = ['read_products', 'write_products'] as const;
export type AccessScope = (typeof ACCESS_SCOPES)[number];

export function isAccessScope(value: string): value is AccessScope {
  return (ACCESS_SCOPES as readonly string[]).includes(value);
}

/**
 * The caller and the shop it acts for. Authentication sets it once per request; nothing
 * downstream takes a shop id from user input.
 */
export interface TenantContext {
  readonly shopId: string;
  /** The shop currency; catalog prices are stored in it. */
  readonly currency: CurrencyCode;
  readonly tokenId: string;
  readonly scopes: ReadonlySet<string>;
}

export function hasScope(tenant: TenantContext, scope: AccessScope): boolean {
  if (tenant.scopes.has(scope)) return true;
  return scope.startsWith('read_') && tenant.scopes.has(`write_${scope.slice('read_'.length)}`);
}
