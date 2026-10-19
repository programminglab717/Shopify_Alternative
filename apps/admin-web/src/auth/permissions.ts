import type { ShopAccess, StaffRole } from './session';

// What a member may do in a shop, as the admin decides what to show them (ADM-01, ADR-580): the
// scopes and capabilities `/auth/me` gives for each of their shops, their custom role's or else
// their preset's, which the core checks each of their requests against (ADR-578). Each of the
// admin's gates names the roles whose work it is and the permission it needs: a preset's member
// passes it as their role did, and a custom role's only while they hold the permission. A session
// the core told no more than the role, as one opened before it said more, is let in by the role.

/** API scopes as the core names them: `write_x` implies `read_x`. */
export type AccessScope =
  | 'read_products'
  | 'write_products'
  | 'read_inventory'
  | 'write_inventory'
  | 'read_locations'
  | 'write_locations'
  | 'read_orders'
  | 'write_orders'
  | 'read_customers'
  | 'write_customers'
  | 'read_segments'
  | 'write_segments'
  | 'read_settings'
  | 'write_settings'
  | 'read_themes'
  | 'write_themes'
  | 'read_online_store_navigation'
  | 'write_online_store_navigation'
  | 'read_online_store_pages'
  | 'write_online_store_pages'
  | 'read_content'
  | 'write_content'
  | 'read_domains'
  | 'write_domains'
  | 'read_legal_policies'
  | 'write_legal_policies'
  | 'read_translations'
  | 'write_translations'
  | 'read_discounts'
  | 'write_discounts'
  | 'read_files'
  | 'write_files'
  | 'read_pixels'
  | 'write_pixels'
  | 'read_marketing_events'
  | 'write_marketing_events'
  | 'read_store_credit_accounts'
  | 'read_store_credit_account_transactions'
  | 'write_store_credit_account_transactions'
  | 'read_gift_cards'
  | 'write_gift_cards'
  | 'read_conversations'
  | 'write_conversations';

/** What staff may do beyond their scopes (ADR-578), as the core names it. */
export type StaffCapability =
  | 'see_customer_numbers'
  | 'reveal_customer_numbers'
  | 'export_orders'
  | 'manage_export_schedules'
  | 'refund_orders'
  | 'assign_orders'
  | 'moderate_comments'
  | 'see_staff_performance'
  | 'reconcile_payments'
  | 'claim_from_couriers'
  | 'manage_staff'
  | 'manage_apps'
  | 'see_billing'
  | 'see_verification'
  | 'manage_support_access';

/** What the admin knows of a member's access to a shop: their role, and what they hold there. */
export type Access = Pick<ShopAccess, 'role' | 'scopes' | 'capabilities'>;

/** Whether the member holds `scope` in the shop: it, or the write of what it reads. */
export function can(shop: Access, scope: AccessScope): boolean {
  const scopes = shop.scopes ?? [];
  return (
    scopes.includes(scope) ||
    (scope.startsWith('read_') && scopes.includes(`write_${scope.slice('read_'.length)}`))
  );
}

/** Whether the member holds `capability` in the shop. */
export function hasCapability(shop: Access, capability: StaffCapability): boolean {
  return shop.capabilities?.includes(capability) ?? false;
}

/** What a gate needs: a scope, a capability, or more, as a test of the shop's access. */
export type Permission = AccessScope | StaffCapability | ((shop: Access) => boolean);

/** A page, section or action of the admin: the roles whose work it is, and what it needs. */
export interface Gate {
  /** The presets whose members see it; a member with nothing more from the core passes by it. */
  readonly roles: readonly StaffRole[];
  readonly needs: Permission;
}

export function gate(roles: readonly StaffRole[], needs: Permission): Gate {
  return { roles, needs };
}

const isScope = (needs: string): needs is AccessScope =>
  needs.startsWith('read_') || needs.startsWith('write_');

/**
 * Whether the member passes `gate` in the shop: their role is one it is for, and they hold what
 * it needs, unless the core said nothing of what they hold.
 */
export function permits(shop: Access, gate: Gate): boolean {
  if (!gate.roles.includes(shop.role)) return false;
  if (!shop.scopes || !shop.capabilities) return true;
  const { needs } = gate;
  if (typeof needs === 'function') return needs(shop);
  return isScope(needs) ? can(shop, needs) : hasCapability(shop, needs);
}
