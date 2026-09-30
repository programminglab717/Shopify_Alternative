import type { CurrencyCode } from '@hatti/money';
import { maskPkMobile } from '@hatti/pk';

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
  'read_customers',
  'write_customers',
  'read_segments',
  'write_segments',
  'read_settings',
  'write_settings',
  'read_themes',
  'write_themes',
  'read_online_store_navigation',
  'write_online_store_navigation',
  'read_online_store_pages',
  'write_online_store_pages',
  'read_domains',
  'write_domains',
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
 * accountants view them. Customers and the blocklist: owner and manager edit, confirmation agents
 * and marketers view, packers and accountants see none. Segments: owner, manager and marketer
 * build them. Shop settings and policies, such as when risky orders wait for review, and the online
 * store's themes, menus and domains: owner and manager only. Its pages, which are content:
 * marketers too.
 */
export const ROLE_SCOPES: Readonly<Record<StaffRole, readonly AccessScope[]>> = {
  owner: [
    ...EDIT_CATALOG,
    'write_orders',
    'write_customers',
    'write_segments',
    'write_settings',
    'write_themes',
    'write_online_store_navigation',
    'write_online_store_pages',
    'write_domains',
  ],
  manager: [
    ...EDIT_CATALOG,
    'write_orders',
    'write_customers',
    'write_segments',
    'write_settings',
    'write_themes',
    'write_online_store_navigation',
    'write_online_store_pages',
    'write_domains',
  ],
  confirmation_agent: [...VIEW_CATALOG, 'write_orders', 'read_customers'],
  packer: [...VIEW_CATALOG, 'write_orders'],
  marketer: [
    ...VIEW_CATALOG,
    'read_orders',
    'read_customers',
    'write_segments',
    'write_online_store_pages',
  ],
  accountant: [...VIEW_CATALOG, 'read_orders'],
};

/**
 * How much of customers' mobile numbers a caller sees: whole, masked with a logged reveal, or
 * masked (docs/architecture/11-security-and-compliance.md §2.1).
 */
export type PhoneAccess = 'full' | 'reveal' | 'masked';

/**
 * Owners and managers see numbers whole. Confirmation agents call customers, so they see numbers
 * masked and reveal one when they need it, which is logged. Packers, marketers and accountants
 * see them masked.
 */
export const ROLE_PHONE_ACCESS: Readonly<Record<StaffRole, PhoneAccess>> = {
  owner: 'full',
  manager: 'full',
  confirmation_agent: 'reveal',
  packer: 'masked',
  marketer: 'masked',
  accountant: 'masked',
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

/** How much of customers' numbers the caller sees. Apps see what their scopes allow, whole. */
export function phoneAccess(tenant: TenantContext): PhoneAccess {
  return tenant.actor.kind === 'staff' ? ROLE_PHONE_ACCESS[tenant.actor.role] : 'full';
}

/** A customer's number as the caller may see it: whole, or masked like "0300 ••••567". */
export function shownPhone(tenant: TenantContext, e164: string): string {
  return phoneAccess(tenant) === 'full' ? e164 : maskPkMobile(e164);
}

/** Who did something, as the audit log and events record it. */
export function actorColumnsOf(actor: Actor): {
  actorKind: 'app' | 'staff';
  actorId: string;
  actorRole: StaffRole | null;
} {
  return actor.kind === 'app'
    ? { actorKind: 'app', actorId: actor.tokenId, actorRole: null }
    : { actorKind: 'staff', actorId: actor.userId, actorRole: actor.role };
}
