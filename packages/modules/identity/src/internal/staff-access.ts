import { MFA_REQUIRED_ROLES, ROLE_SCOPES, isStaffRole, type TenantContext } from '@hatti/api';
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
  /** A valid session without an active membership in that shop. */
  | { ok: false; reason: 'no_shop_access' }
  /** The role needs two-step verification and this session has not passed it. */
  | { ok: false; reason: 'mfa_required' };

interface Row extends Record<string, unknown> {
  user_id: string;
  session_id: string;
  mfa_verified: boolean;
  authenticated_at: Date | string;
  role: string | null;
  shop_currency: string | null;
}

/**
 * Turns a staff access token plus the shop a request names into a tenant context, for the
 * Admin API. Uses the request-serving login: the identity tables stay out of its reach, and one
 * SECURITY DEFINER function answers the question.
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
    if (!role || !isStaffRole(role) || !currency || !isCurrencyCode(currency)) {
      return { ok: false, reason: 'no_shop_access' };
    }
    if (MFA_REQUIRED_ROLES.has(role) && !row.mfa_verified) {
      return { ok: false, reason: 'mfa_required' };
    }
    return {
      ok: true,
      tenant: {
        shopId,
        currency,
        scopes: new Set(ROLE_SCOPES[role]),
        actor: {
          kind: 'staff',
          userId: row.user_id,
          sessionId: row.session_id,
          role,
          authenticatedAt: toDate(row.authenticated_at),
        },
      },
    };
  }
}
