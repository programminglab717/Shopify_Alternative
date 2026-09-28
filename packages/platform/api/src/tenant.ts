import type { CurrencyCode } from '@hatti/money';

/**
 * Access scopes, named like Shopify's: read_<resource> and write_<resource>.
 * write_<resource> implies read_<resource>.
 */
export const ACCESS_SCOPES = [
  'read_products',
  'write_products',
  'read_inventory',
  'write_inventory',
  'read_locations',
  'write_locations',
  'read_orders',
  'write_orders',
] as const;
export type AccessScope = (typeof ACCESS_SCOPES)[number];

export function isAccessScope(value: string): value is AccessScope {
  return (ACCESS_SCOPES as readonly string[]).includes(value);
}

/** Staff role presets (docs/design/02-information-architecture.md §6). */
export const STAFF_ROLES = [
  'owner',
  'manager',
  'confirmation_agent',
  'packer',
  'marketer',
  'accountant',
] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

export function isStaffRole(value: string): value is StaffRole {
  return (STAFF_ROLES as readonly string[]).includes(value);
}

const EDIT_CATALOG: readonly AccessScope[] = [
  'write_products',
  'write_inventory',
  'write_locations',
];
const VIEW_CATALOG: readonly AccessScope[] = ['read_products', 'read_inventory', 'read_locations'];

/**
 * API scopes each role preset grants. Products, stock and locations: owner and manager edit,
 * everyone else views. Orders: confirmation agents and packers work on them too; marketers and
 * accountants view them.
 */
export const ROLE_SCOPES: Readonly<Record<StaffRole, readonly AccessScope[]>> = {
  owner: [...EDIT_CATALOG, 'write_orders'],
  manager: [...EDIT_CATALOG, 'write_orders'],
  confirmation_agent: [...VIEW_CATALOG, 'write_orders'],
  packer: [...VIEW_CATALOG, 'write_orders'],
  marketer: [...VIEW_CATALOG, 'read_orders'],
  accountant: [...VIEW_CATALOG, 'read_orders'],
};

/**
 * Roles that must pass two-step verification before using a shop: owners, and roles with finance,
 * payments, staff-management or export powers (docs/architecture/11-security-and-compliance.md).
 */
export const MFA_REQUIRED_ROLES: ReadonlySet<StaffRole> = new Set([
  'owner',
  'manager',
  'accountant',
]);

/** Who is making the request. */
export type Actor =
  | { readonly kind: 'app'; readonly tokenId: string }
  | {
      readonly kind: 'staff';
      readonly userId: string;
      readonly sessionId: string;
      readonly role: StaffRole;
    };

/**
 * The caller and the shop it acts for. Authentication sets it once per request, after checking
 * that the caller may act for that shop; nothing downstream takes a shop id from user input.
 */
export interface TenantContext {
  readonly shopId: string;
  /** The shop currency; catalog prices are stored in it. */
  readonly currency: CurrencyCode;
  readonly scopes: ReadonlySet<string>;
  readonly actor: Actor;
}

export function hasScope(tenant: TenantContext, scope: AccessScope): boolean {
  if (tenant.scopes.has(scope)) return true;
  return scope.startsWith('read_') && tenant.scopes.has(`write_${scope.slice('read_'.length)}`);
}
