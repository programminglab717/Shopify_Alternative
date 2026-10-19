import {
  MFA_REQUIRED_ROLES,
  SUPPORT_SCOPES,
  isStaffRole,
  staffCapabilities,
  staffScopes,
  type TenantContext,
} from '@hatti/api';
import { sha256 } from '@hatti/crypto';
import { toDate, type Db } from '@hatti/db';
import { isUuid } from '@hatti/ids';
import { isCurrencyCode } from '@hatti/money';
import { sql } from 'drizzle-orm';
import { ACCESS_TOKEN_PATTERN } from './identity.service.js';

export type StaffAccessResult =
  | { ok: true; tenant: TenantContext }
  /** Unknown, expired or revoked token: the client should refresh or sign in again. */
  | { ok: false; reason: 'unauthenticated' }
  /**
   * A valid session without an active membership in that shop, nor, for Hatti's support, the
   * owner's grant open now.
   */
  | { ok: false; reason: 'no_shop_access' }
  /** The role, or Hatti's support, needs two-step verification and this session has not passed it. */
  | { ok: false; reason: 'mfa_required' };

interface Row extends Record<string, unknown> {
  user_id: string;
  session_id: string;
  mfa_verified: boolean;
  authenticated_at: Date | string;
  role: string | null;
  shop_currency: string | null;
  /** The owner's grant open now, for Hatti's support in a shop it does not work in (ADR-156). */
  support_grant_id: string | null;
  /** The membership's custom role (ADR-578), with its scopes and capabilities; null for a preset's. */
  custom_role_id: string | null;
  custom_scopes: string[] | null;
  custom_capabilities: string[] | null;
}

/**
 * Turns a staff access token plus the shop a request names into a tenant context, for the
 * Admin API: a member of its staff in their role, with its preset's scopes and capabilities or
 * their custom role's (ADR-578), or Hatti's support, reading alone, while the shop's owner allows
 * it (ADR-156). Uses the request-serving login: the identity tables stay out of its reach, and
 * one SECURITY DEFINER function answers the question, on every request, so that a change to a
 * member's role or their custom role counts from their next.
 */
export class StaffAccessResolver {
  constructor(private readonly db: Db) {}

  async resolve(accessToken: string, shopId: string): Promise<StaffAccessResult> {
    if (!ACCESS_TOKEN_PATTERN.test(accessToken)) return { ok: false, reason: 'unauthenticated' };
    if (!isUuid(shopId)) return { ok: false, reason: 'no_shop_access' };
    const { rows } = await this.db.execute<Row>(
      sql`select * from identity.resolve_staff_access(${sha256(accessToken)}, ${shopId})`,
    );
    const row = rows[0];
    if (!row) return { ok: false, reason: 'unauthenticated' };
    const { role, shop_currency: currency } = row;
    if (!currency || !isCurrencyCode(currency)) return { ok: false, reason: 'no_shop_access' };
    if (!role && row.support_grant_id) {
      // Hatti's support always proves who it is with a second factor.
      if (!row.mfa_verified) return { ok: false, reason: 'mfa_required' };
      return {
        ok: true,
        tenant: {
          shopId,
          currency,
          scopes: new Set(SUPPORT_SCOPES),
          actor: {
            kind: 'support',
            userId: row.user_id,
            sessionId: row.session_id,
            grantId: row.support_grant_id,
            authenticatedAt: toDate(row.authenticated_at),
          },
        },
      };
    }
    if (!role || !isStaffRole(role)) return { ok: false, reason: 'no_shop_access' };
    if (MFA_REQUIRED_ROLES.has(role) && !row.mfa_verified) {
      return { ok: false, reason: 'mfa_required' };
    }
    // A custom role's, within its preset's still; else the preset's.
    const custom = row.custom_role_id !== null;
    return {
      ok: true,
      tenant: {
        shopId,
        currency,
        scopes: new Set(staffScopes(role, custom ? (row.custom_scopes ?? []) : null)),
        actor: {
          kind: 'staff',
          userId: row.user_id,
          sessionId: row.session_id,
          role,
          customRoleId: row.custom_role_id,
          capabilities: staffCapabilities(role, custom ? (row.custom_capabilities ?? []) : null),
          authenticatedAt: toDate(row.authenticated_at),
        },
      },
    };
  }
}
