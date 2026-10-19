import {
  ACCESS_SCOPES,
  InputChecker,
  PRESET_CAPABILITIES,
  ROLE_SCOPES,
  STAFF_CAPABILITIES,
  isAccessScope,
  isStaffCapability,
  isStaffRole,
  scopeWithin,
  staffCapabilities,
  staffScopes,
  type AccessScope,
  type StaffCapability,
  type StaffRole,
} from '@hatti/api';
import type { Db } from '@hatti/db';
import { and, eq, sql } from 'drizzle-orm';
import { customRoles } from './schema.js';

// A shop's own staff roles (ADM-01, ADR-578): each made from a preset other than the owner's, for
// good, holding some of its scopes and capabilities, never more. Its members keep the preset as
// their role, and read the custom role's scopes and capabilities on each request.

export const CUSTOM_ROLE_LIMITS = {
  /** Characters in a custom role's name. */
  name: 40,
  /** Custom roles a shop has. */
  perShop: 50,
} as const;

/** A shop's custom role, with how many of its staff hold it now. */
export interface CustomRoleRecord {
  id: string;
  name: string;
  /** The preset it was made from: its members' role. */
  basedOn: StaffRole;
  scopes: AccessScope[];
  capabilities: StaffCapability[];
  /** Members of staff who hold it, collaborators whose access has not ended among them. */
  members: number;
  createdAt: Date;
  updatedAt: Date;
}

/** A custom role as it is made: all of it. */
export interface CustomRoleCreateInput {
  name: string;
  basedOn: string;
  scopes: readonly string[];
  capabilities: readonly string[];
}

/** What changes of a custom role: what is given. Its preset stays. */
export interface CustomRoleUpdateInput {
  name?: string | null;
  scopes?: readonly string[] | null;
  capabilities?: readonly string[] | null;
}

/** A role to give: a preset, or a custom role by its ID, whose preset is the role then. */
export interface StaffRoleChoice {
  role?: string | null;
  customRoleId?: string | null;
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type CustomRoleRow = typeof customRoles.$inferSelect;

/**
 * The name, trimmed, at `field`: 1 to 40 characters, and no other custom role's of the shop,
 * whatever its case.
 */
export async function checkedName(
  tx: Tx,
  check: InputChecker,
  shopId: string,
  name: string | null | undefined,
  except: string | null,
): Promise<string | null> {
  const field = ['input', 'name'];
  const checked = check.text(field, name, { required: true, max: CUSTOM_ROLE_LIMITS.name });
  if (!checked || checked.length > CUSTOM_ROLE_LIMITS.name) return checked;
  const [taken] = await tx
    .select({ id: customRoles.id })
    .from(customRoles)
    .where(
      and(
        eq(customRoles.shopId, shopId),
        sql`lower(${customRoles.name}) = lower(${checked})`,
        except ? sql`${customRoles.id} <> ${except}` : undefined,
      ),
    );
  if (taken) check.add(field, 'TAKEN', "is another role's name");
  return checked;
}

/**
 * The scopes given, each within `basedOn`'s: one of them, or the read of a resource it writes;
 * in the order the API lists them, once each.
 */
export function checkedScopes(
  check: InputChecker,
  basedOn: StaffRole,
  scopes: readonly string[],
): AccessScope[] {
  const preset = ROLE_SCOPES[basedOn];
  scopes.forEach((scope, index) => {
    const field = ['input', 'scopes', String(index)];
    if (!isAccessScope(scope))
      check.addMessage(field, 'INVALID', `${scope} is not an access scope`);
    else if (!scopeWithin(scope, preset)) {
      check.addMessage(field, 'INVALID', `${scope} is beyond the ${presetName(basedOn)} role's`);
    }
  });
  return ACCESS_SCOPES.filter((scope) => scopes.includes(scope));
}

/** The capabilities given, each `basedOn`'s; in the order the API lists them, once each. */
export function checkedCapabilities(
  check: InputChecker,
  basedOn: StaffRole,
  capabilities: readonly string[],
): StaffCapability[] {
  const preset = PRESET_CAPABILITIES[basedOn];
  capabilities.forEach((capability, index) => {
    const field = ['input', 'capabilities', String(index)];
    if (!isStaffCapability(capability)) {
      check.addMessage(field, 'INVALID', `${capability} is not a capability`);
    } else if (!preset.includes(capability)) {
      check.addMessage(
        field,
        'INVALID',
        `${capability} is beyond the ${presetName(basedOn)} role's`,
      );
    }
  });
  return STAFF_CAPABILITIES.filter((capability) => capabilities.includes(capability));
}

/** The preset a custom role is made from, at `field`: any but the owner's. */
export function checkedBasedOn(check: InputChecker, basedOn: string): StaffRole | null {
  if (!isStaffRole(basedOn)) {
    check.add(['input', 'basedOn'], 'INVALID', 'is not a role preset');
    return null;
  }
  if (basedOn === 'owner') {
    check.addMessage(
      ['input', 'basedOn'],
      'INVALID',
      "A shop has one owner: a custom role is made from another role's preset",
    );
    return null;
  }
  return basedOn;
}

/** What a member of staff holds in a shop: their scopes and their capabilities. */
export interface MemberAccess {
  scopes: AccessScope[];
  capabilities: ReadonlySet<StaffCapability>;
}

/**
 * A member of staff's access in `role`: their custom role's scopes and capabilities, as far as
 * its preset holds them still, where `custom` is one's, or else the preset's. What each request
 * resolves, and what the admin is told of the shops it opens (ADR-580), alike.
 */
export function memberAccess(
  role: StaffRole,
  custom: { scopes: readonly string[] | null; capabilities: readonly string[] | null } | null,
): MemberAccess {
  return {
    scopes: staffScopes(role, custom ? (custom.scopes ?? []) : null),
    capabilities: staffCapabilities(role, custom ? (custom.capabilities ?? []) : null),
  };
}

/** The shop's custom role `id`, shared-locked so that it is not deleted meanwhile; null if none. */
export async function customRoleIn(
  tx: Tx,
  shopId: string,
  id: string,
  lock: 'share' | 'update' = 'share',
): Promise<CustomRoleRow | null> {
  const [row] = await tx
    .select()
    .from(customRoles)
    .where(and(eq(customRoles.shopId, shopId), eq(customRoles.id, id)))
    .for(lock);
  return row ?? null;
}

/** A custom role's row as a record, with `members` holding it. */
export function toCustomRole(row: CustomRoleRow, members: number): CustomRoleRecord | null {
  if (!isStaffRole(row.basedOn)) return null;
  return {
    id: row.id,
    name: row.name,
    basedOn: row.basedOn,
    scopes: row.scopes.filter(isAccessScope),
    capabilities: row.capabilities.filter(isStaffCapability),
    members,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function presetName(role: StaffRole): string {
  return role.replace('_', ' ');
}
