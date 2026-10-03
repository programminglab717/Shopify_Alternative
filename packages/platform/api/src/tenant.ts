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
  'read_content',
  'write_content',
  'read_domains',
  'write_domains',
  'read_legal_policies',
  'write_legal_policies',
  'read_discounts',
  'write_discounts',
  'read_files',
  'write_files',
  'read_pixels',
  'write_pixels',
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
 * build them. Shop settings and policies, such as when risky orders wait for review, the online
 * store's themes, menus and domains, and its legal policies: owner and manager only. Its pages
 * and blogs, which are content (ADR-176), discount codes, which are marketing, the files they
 * upload, and the ad platforms its orders go to (ADR-143): marketers too.
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
    'write_content',
    'write_domains',
    'write_legal_policies',
    'write_discounts',
    'write_files',
    'write_pixels',
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
    'write_content',
    'write_domains',
    'write_legal_policies',
    'write_discounts',
    'write_files',
    'write_pixels',
  ],
  confirmation_agent: [...VIEW_CATALOG, 'write_orders', 'read_customers'],
  packer: [...VIEW_CATALOG, 'write_orders'],
  marketer: [
    ...VIEW_CATALOG,
    'read_orders',
    'read_customers',
    'write_segments',
    'write_online_store_pages',
    'write_content',
    'write_discounts',
    'write_files',
    'write_pixels',
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
      /**
       * When they last proved who they are in this session: signing in, or re-authenticating
       * since (ADR-103).
       */
      readonly authenticatedAt: Date;
    }
  | SupportActor;

/**
 * Hatti's support, looking at a shop whose owner allows it for a while (ADR-156): an agent signed
 * in to their own account with a second factor. It reads, masked as most staff see, and changes
 * nothing: the Admin API refuses its mutations before they run, and logs each of its requests.
 */
export interface SupportActor {
  readonly kind: 'support';
  readonly userId: string;
  readonly sessionId: string;
  /** The owner's grant it looks under, which ends when the owner ends it or its time is up. */
  readonly grantId: string;
  readonly authenticatedAt: Date;
}

/** The scopes Hatti's support looks with: every resource's read, and no write. */
export const SUPPORT_SCOPES: readonly AccessScope[] = ACCESS_SCOPES.filter((scope) =>
  scope.startsWith('read_'),
);

/**
 * How long staff may take sensitive actions after proving who they are (ADR-103): signing in,
 * or re-authenticating with their password, a passkey or their authenticator app.
 */
export const REAUTHENTICATION_WINDOW_MS = 15 * 60_000;

/**
 * Whether the caller may take a sensitive action now: staff who proved who they are within
 * {@link REAUTHENTICATION_WINDOW_MS}, and apps, which have no one to ask.
 */
export function recentlyAuthenticated(tenant: TenantContext, now: Date): boolean {
  return (
    tenant.actor.kind === 'app' ||
    now.getTime() - tenant.actor.authenticatedAt.getTime() < REAUTHENTICATION_WINDOW_MS
  );
}

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

/**
 * How much of customers' numbers the caller sees. Apps see what their scopes allow, whole; Hatti's
 * support sees them masked.
 */
export function phoneAccess(tenant: TenantContext): PhoneAccess {
  switch (tenant.actor.kind) {
    case 'staff':
      return ROLE_PHONE_ACCESS[tenant.actor.role];
    case 'support':
      return 'masked';
    default:
      return 'full';
  }
}

/** A customer's number as the caller may see it: whole, or masked like "0300 ••••567". */
export function shownPhone(tenant: TenantContext, e164: string): string {
  return phoneAccess(tenant) === 'full' ? e164 : maskPkMobile(e164);
}

/**
 * Who did something, as the audit log and events record it. Hatti's support changes nothing, so
 * nothing it does is recorded so: its requests are logged apart ({@link supportColumnsOf}).
 */
export function actorColumnsOf(actor: Actor): {
  actorKind: 'app' | 'staff';
  actorId: string;
  actorRole: StaffRole | null;
} {
  switch (actor.kind) {
    case 'app':
      return { actorKind: 'app', actorId: actor.tokenId, actorRole: null };
    case 'staff':
      return { actorKind: 'staff', actorId: actor.userId, actorRole: actor.role };
    default:
      throw new Error("Hatti's support changes nothing in a shop");
  }
}

/** Hatti's support, as the audit log records what it looked at (ADR-156). */
export function supportColumnsOf(actor: SupportActor): {
  actorKind: 'support';
  actorId: string;
  actorRole: null;
} {
  return { actorKind: 'support', actorId: actor.userId, actorRole: null };
}
