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
  'read_translations',
  'write_translations',
  'read_discounts',
  'write_discounts',
  'read_files',
  'write_files',
  'read_pixels',
  'write_pixels',
  'read_marketing_events',
  'write_marketing_events',
  'read_store_credit_accounts',
  'read_store_credit_account_transactions',
  'write_store_credit_account_transactions',
  'read_gift_cards',
  'write_gift_cards',
  'read_conversations',
  'write_conversations',
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
 * and blogs, which are content (ADR-176), and its content's Urdu (ADR-238), discount codes, which
 * are marketing, the files they upload, the ad platforms its orders go to (ADR-143), and the
 * shop's own WhatsApp templates and broadcasts (ADR-420): marketers too. Store credit (ADR-184):
 * owners and managers credit and debit it; accountants see it all, and confirmation agents what
 * a customer has. Gift cards (ADR-448), likewise: owners and managers issue and change them;
 * accountants and confirmation agents look them up. The inbox's conversations with customers
 * (ADR-545): owners, managers and confirmation agents work them; marketers read them.
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
    'write_translations',
    'write_discounts',
    'write_files',
    'write_pixels',
    'write_marketing_events',
    'read_store_credit_accounts',
    'write_store_credit_account_transactions',
    'write_gift_cards',
    'write_conversations',
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
    'write_translations',
    'write_discounts',
    'write_files',
    'write_pixels',
    'write_marketing_events',
    'read_store_credit_accounts',
    'write_store_credit_account_transactions',
    'write_gift_cards',
    'write_conversations',
  ],
  confirmation_agent: [
    ...VIEW_CATALOG,
    'write_orders',
    'read_customers',
    'read_store_credit_accounts',
    'read_gift_cards',
    'write_conversations',
  ],
  packer: [...VIEW_CATALOG, 'write_orders'],
  marketer: [
    ...VIEW_CATALOG,
    'read_orders',
    'read_customers',
    'write_segments',
    'write_online_store_pages',
    'write_content',
    'write_translations',
    'write_discounts',
    'write_files',
    'write_pixels',
    'write_marketing_events',
    'read_conversations',
  ],
  accountant: [
    ...VIEW_CATALOG,
    'read_orders',
    'read_store_credit_accounts',
    'read_store_credit_account_transactions',
    'read_gift_cards',
  ],
};

/**
 * How much of customers' mobile numbers a caller sees: whole, masked with a logged reveal, or
 * masked (docs/architecture/11-security-and-compliance.md §2.1).
 */
export type PhoneAccess = 'full' | 'reveal' | 'masked';

/**
 * What staff may do beyond their scopes, which each role preset holds as {@link
 * PRESET_CAPABILITIES} says and a custom role holds some of (ADM-01, ADR-578):
 *
 * - `see_customer_numbers`: customers' mobile numbers whole.
 * - `reveal_customer_numbers`: one number at a time, revealed on the audit log, where they are
 *   masked otherwise.
 * - `export_orders`: orders as a file, now or scheduled to their email (ADR-183).
 * - `manage_export_schedules`: delete anyone's scheduled export, not their own alone.
 * - `refund_orders`: record refunds, and settle those a gateway never answered.
 * - `assign_orders`: give an order to anyone, and take it from whoever has it (ADR-127).
 * - `moderate_comments`: delete anyone's comment on an order (ADR-128).
 * - `see_staff_performance`: how each confirmation agent and packer did.
 * - `reconcile_payments`: couriers' remittances, gateways' settlements, and what the shop is paid.
 * - `claim_from_couriers`: claims for parcels couriers lost or damaged (ADR-093).
 * - `manage_staff`: staff, their invitations, requests for access and custom roles, within the
 *   roles their preset manages (ADR-101).
 * - `manage_apps`: the shop's custom apps and apps' webhooks.
 * - `see_billing`: what the shop pays Hatti.
 * - `see_verification`: the shop's verification by Hatti (ADR-465).
 * - `manage_support_access`: see Hatti's support's access to the shop, and end it (ADR-156).
 *
 * What only the owner does is no capability: their role says it, and no custom role is one.
 */
export const STAFF_CAPABILITIES = [
  'see_customer_numbers',
  'reveal_customer_numbers',
  'export_orders',
  'manage_export_schedules',
  'refund_orders',
  'assign_orders',
  'moderate_comments',
  'see_staff_performance',
  'reconcile_payments',
  'claim_from_couriers',
  'manage_staff',
  'manage_apps',
  'see_billing',
  'see_verification',
  'manage_support_access',
] as const;
export type StaffCapability = (typeof STAFF_CAPABILITIES)[number];

export function isStaffCapability(value: string): value is StaffCapability {
  return (STAFF_CAPABILITIES as readonly string[]).includes(value);
}

/**
 * The capabilities each role preset holds. Owners and managers hold them all. Confirmation agents
 * call customers, so they see numbers masked and reveal one when they need it, which is logged.
 * Accountants export orders, reconcile what the shop is paid and claim from couriers. Packers and
 * marketers hold none: they see numbers masked, and exports of marketers' would need an approval
 * flow that does not exist yet (docs/architecture/11-security-and-compliance.md §2.1).
 */
export const PRESET_CAPABILITIES: Readonly<Record<StaffRole, readonly StaffCapability[]>> = {
  owner: STAFF_CAPABILITIES,
  manager: STAFF_CAPABILITIES,
  confirmation_agent: ['reveal_customer_numbers'],
  packer: [],
  marketer: [],
  accountant: ['export_orders', 'reconcile_payments', 'claim_from_couriers'],
};

const PRESET_CAPABILITY_SETS: Readonly<Record<StaffRole, ReadonlySet<StaffCapability>>> = {
  owner: new Set(PRESET_CAPABILITIES.owner),
  manager: new Set(PRESET_CAPABILITIES.manager),
  confirmation_agent: new Set(PRESET_CAPABILITIES.confirmation_agent),
  packer: new Set(PRESET_CAPABILITIES.packer),
  marketer: new Set(PRESET_CAPABILITIES.marketer),
  accountant: new Set(PRESET_CAPABILITIES.accountant),
};

/**
 * Whether `scope` is within `granted`: one of them, or the read of a resource they write. A
 * custom role's scopes are within its preset's so, each of them.
 */
export function scopeWithin(scope: AccessScope, granted: readonly AccessScope[]): boolean {
  return (
    granted.includes(scope) ||
    (scope.startsWith('read_') &&
      granted.includes(`write_${scope.slice('read_'.length)}` as AccessScope))
  );
}

/**
 * The scopes of a member of staff in `role`: its preset's, or their custom role's (ADR-578), as
 * far as they are within the preset's still.
 */
export function staffScopes(role: StaffRole, custom: readonly string[] | null): AccessScope[] {
  const preset = ROLE_SCOPES[role];
  if (!custom) return [...preset];
  return custom.filter(
    (scope): scope is AccessScope => isAccessScope(scope) && scopeWithin(scope, preset),
  );
}

/**
 * The capabilities of a member of staff in `role`: its preset's, or their custom role's
 * (ADR-578), as far as the preset holds them still.
 */
export function staffCapabilities(
  role: StaffRole,
  custom: readonly string[] | null,
): ReadonlySet<StaffCapability> {
  const preset = PRESET_CAPABILITY_SETS[role];
  if (!custom) return preset;
  return new Set(
    custom.filter(
      (capability): capability is StaffCapability =>
        isStaffCapability(capability) && preset.has(capability),
    ),
  );
}

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
      /** Their role's preset; for a custom role, the preset it was made from. */
      readonly role: StaffRole;
      /** Their custom role (ADR-578); null or absent for a preset's. */
      readonly customRoleId?: string | null;
      /**
       * What they may do beyond their scopes: their custom role's capabilities; absent, their
       * preset's ({@link hasCapability}).
       */
      readonly capabilities?: ReadonlySet<StaffCapability>;
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
 * Whether the caller is a member of staff with `capability`: their custom role's, or else their
 * preset's. Apps and Hatti's support hold none: what apps may do their scopes say.
 */
export function hasCapability(actor: Actor, capability: StaffCapability): boolean {
  if (actor.kind !== 'staff') return false;
  return (actor.capabilities ?? PRESET_CAPABILITY_SETS[actor.role]).has(capability);
}

/**
 * How much of customers' numbers the caller sees: staff as their capabilities say, whole, masked
 * with a logged reveal, or masked. Apps see what their scopes allow, whole; Hatti's support sees
 * them masked.
 */
export function phoneAccess(tenant: TenantContext): PhoneAccess {
  const { actor } = tenant;
  switch (actor.kind) {
    case 'staff':
      if (hasCapability(actor, 'see_customer_numbers')) return 'full';
      return hasCapability(actor, 'reveal_customer_numbers') ? 'reveal' : 'masked';
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
