import { randomInt } from 'node:crypto';
import { MFA_REQUIRED_ROLES, isStaffRole, type StaffRole } from '@hatti/api';
import type { Db } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import { newId, toPublicId } from '@hatti/ids';
import { sql } from 'drizzle-orm';
import { AuthError } from './errors.js';
import type { AuthenticatedSession, OpenedShop } from './identity.service.js';
import {
  SHOP_LIMITS,
  ShopEvents,
  handleFrom,
  handleProblem,
  insertShop,
  type ShopOpenedPayload,
} from './shops.js';

// Partners (PRT-01, ADR-504): agencies and freelancers who build stores for others. They join from
// their own accounts, open development stores that stay closed to shoppers while they build them,
// hand each to its client as an owner hands over any shop (ADR-104), and see every store they made,
// brought or work in, in one place.

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export const PARTNER_LIMITS = {
  businessName: 120,
  website: 300,
} as const;

export interface PartnerProfile {
  businessName: string;
  website: string | null;
  /** For links that bring a store to the partner (PRT-02). */
  referralCode: string;
  joinedAt: Date;
}

/**
 * How a store is the partner's: a development store they build, or built and handed over; one
 * whose owner came by their code; or a client's they work in.
 */
export type PartnerStoreKind = 'development' | 'transferred' | 'referred' | 'client';

export interface PartnerStore {
  shopId: string;
  name: string;
  handle: string;
  status: 'active' | 'suspended' | 'closed';
  kind: PartnerStoreKind;
  /** The partner's role in it now; null where they no longer work in it. */
  role: StaffRole | null;
  /** Until when, for a collaborator's access (ADR-487). */
  accessEndsAt: Date | null;
  since: Date;
  transferredAt: Date | null;
}

/** Letters and digits a referral code is made of: none that reads as another. */
const CODE_LETTERS = 'abcdefghjkmnpqrstuvwxyz23456789';

export class PartnersService {
  private readonly db: Db;
  private readonly now: () => Date;

  constructor(options: { db: Db; now?: () => Date }) {
    this.db = options.db;
    this.now = options.now ?? (() => new Date());
  }

  /** The signed-in account's partner profile; null until they join. */
  async profile(auth: Pick<AuthenticatedSession, 'userId'>): Promise<PartnerProfile | null> {
    const { rows } = await this.db.execute<ProfileRow>(sql`
      SELECT business_name, website, referral_code, created_at
        FROM identity.partners WHERE user_id = ${auth.userId}`);
    return rows[0] ? profileOf(rows[0]) : null;
  }

  /**
   * Joins the partner programme, or changes the partner's details: their business's name and its
   * website, https. A referral code is given on joining, and kept.
   */
  async join(
    auth: Pick<AuthenticatedSession, 'userId'>,
    input: { businessName: string; website?: string | null },
  ): Promise<PartnerProfile> {
    const businessName = input.businessName.replace(/\p{Cc}/gu, '').trim();
    const website = input.website?.trim() || null;
    const fields: Record<string, string> = {};
    if (businessName.length === 0 || businessName.length > PARTNER_LIMITS.businessName) {
      fields.businessName = `Name your business, in ${PARTNER_LIMITS.businessName} characters or fewer`;
    }
    if (website !== null && !websiteOk(website)) {
      fields.website = 'Give its address, starting https://';
    }
    if (Object.keys(fields).length > 0) {
      throw new AuthError('INVALID_INPUT', 422, 'Some details need fixing', { fields });
    }
    for (let attempt = 0; ; attempt += 1) {
      try {
        const { rows } = await this.db.execute<ProfileRow>(sql`
          INSERT INTO identity.partners (user_id, business_name, website, referral_code)
               VALUES (${auth.userId}, ${businessName}, ${website}, ${referralCode()})
          ON CONFLICT (user_id) DO UPDATE
                SET business_name = EXCLUDED.business_name, website = EXCLUDED.website,
                    updated_at = now()
          RETURNING business_name, website, referral_code, created_at`);
        return profileOf(rows[0]!);
      } catch (error) {
        // Another partner has the code: one more try with another, then give up.
        if (attempt < 3 && String((error as { constraint?: string }).constraint).includes('code')) {
          continue;
        }
        throw error;
      }
    }
  }

  /**
   * The partner's stores, the newest first: the development stores they opened, building or
   * handed over; those whose owners came by their code; and their clients', where they work but
   * own no shop of their own.
   */
  async stores(auth: Pick<AuthenticatedSession, 'userId'>): Promise<PartnerStore[]> {
    await this.#partner(this.db, auth.userId);
    const now = this.now();
    const { rows } = await this.db.execute<StoreRow>(sql`
      SELECT s.id, s.name, s.handle, s.status, p.kind, p.created_at AS made_at, p.transferred_at,
             m.role, m.expires_at, m.created_at AS joined_at
        FROM control.shops s
        LEFT JOIN identity.partner_stores p ON p.shop_id = s.id AND p.partner_id = ${auth.userId}
        LEFT JOIN identity.memberships m
               ON m.shop_id = s.id AND m.user_id = ${auth.userId} AND m.status = 'active'
              AND (m.expires_at IS NULL OR m.expires_at > ${now})
       WHERE p.shop_id IS NOT NULL OR (m.user_id IS NOT NULL AND m.role <> 'owner')
       ORDER BY coalesce(p.created_at, m.created_at) DESC, s.id`);
    return rows.map((row) => ({
      shopId: row.id,
      name: row.name,
      handle: row.handle,
      status: row.status,
      kind:
        row.kind === 'development'
          ? row.transferred_at
            ? 'transferred'
            : 'development'
          : (row.kind ?? 'client'),
      role: row.role && isStaffRole(row.role) ? row.role : null,
      accessEndsAt: row.expires_at ? new Date(row.expires_at) : null,
      since: new Date(row.made_at ?? row.joined_at!),
      transferredAt: row.transferred_at ? new Date(row.transferred_at) : null,
    }));
  }

  /**
   * Opens a development store, which the partner owns while they build it (ADR-504): closed to
   * shoppers, its storefront saying it opens soon, until they hand it to its client. It counts
   * against none of the five shops an account may own; a partner builds 20 at once at most.
   */
  async openDevelopmentStore(
    auth: Pick<AuthenticatedSession, 'userId'>,
    input: { name: string; handle?: string | null },
  ): Promise<OpenedShop> {
    const name = input.name.replace(/\p{Cc}/gu, '').trim();
    const asked = input.handle?.trim().toLowerCase() || null;
    const fields: Record<string, string> = {};
    if (name.length === 0 || name.length > SHOP_LIMITS.name) {
      fields.name = `Name the shop, in ${SHOP_LIMITS.name} characters or fewer`;
    }
    const problem = asked === null ? null : handleProblem(asked);
    if (problem) fields.handle = problem;
    if (Object.keys(fields).length > 0) {
      throw new AuthError('INVALID_INPUT', 422, 'Some details need fixing', { fields });
    }
    return this.db.transaction(async (tx) => {
      await this.#partner(tx, auth.userId, { lock: true });
      const { rows } = await tx.execute<{ count: number }>(sql`
        SELECT count(*)::int AS count FROM identity.partner_stores
         WHERE partner_id = ${auth.userId} AND kind = 'development' AND transferred_at IS NULL`);
      if ((rows[0]?.count ?? 0) >= SHOP_LIMITS.developmentStores) {
        throw new AuthError(
          'TOO_MANY_SHOPS',
          422,
          `A partner builds ${SHOP_LIMITS.developmentStores} development stores at once at most: hand one over first`,
        );
      }
      const shopId = newId();
      const handle = await insertShop(tx, shopId, name, asked ?? handleFrom(name), {
        numbered: asked === null,
        development: true,
      });
      await tx.execute(sql`
        INSERT INTO identity.memberships (user_id, shop_id, role)
             VALUES (${auth.userId}, ${shopId}, 'owner')`);
      await tx.execute(sql`
        INSERT INTO identity.partner_stores (shop_id, partner_id, kind)
             VALUES (${shopId}, ${auth.userId}, 'development')`);
      await appendEvent<ShopOpenedPayload>(tx, shopId, {
        type: ShopEvents.ShopOpened,
        aggregateType: 'shop',
        aggregateId: shopId,
        payload: { handle },
      });
      return {
        id: toPublicId('shop', shopId),
        name,
        handle,
        role: 'owner' as const,
        mfaRequired: MFA_REQUIRED_ROLES.has('owner'),
      };
    });
  }

  /** Refuses an account that has not joined the partner programme. */
  async #partner(db: Db | Tx, userId: string, options: { lock?: boolean } = {}): Promise<void> {
    const { rows } = await db.execute(sql`
      SELECT 1 FROM identity.partners WHERE user_id = ${userId}
      ${options.lock ? sql`FOR UPDATE` : sql``}`);
    if (rows.length === 0) {
      throw new AuthError('NOT_PARTNER', 403, "Join Hatti's partner programme first");
    }
  }
}

/**
 * Marks a development store handed to its client, as its partner hands it over (ADR-104): it opens
 * to shoppers, its storefront published again. Nothing for any other shop.
 */
export async function developmentStoreTransferred(
  tx: Tx,
  shopId: string,
  to: string,
  now: Date,
): Promise<boolean> {
  const { rows } = await tx.execute(sql`
    UPDATE identity.partner_stores SET transferred_at = ${now}, transferred_to = ${to}
     WHERE shop_id = ${shopId} AND kind = 'development' AND transferred_at IS NULL
    RETURNING shop_id`);
  if (rows.length === 0) return false;
  await tx.execute(sql`UPDATE control.shops SET development = false WHERE id = ${shopId}`);
  await appendEvent(tx, shopId, {
    type: ShopEvents.DevelopmentStoreTransferred,
    aggregateType: 'shop',
    aggregateId: shopId,
    payload: {},
  });
  return true;
}

interface ProfileRow extends Record<string, unknown> {
  business_name: string;
  website: string | null;
  referral_code: string;
  created_at: string | Date;
}

interface StoreRow extends Record<string, unknown> {
  id: string;
  name: string;
  handle: string;
  status: PartnerStore['status'];
  kind: 'development' | 'referred' | null;
  made_at: string | Date | null;
  transferred_at: string | Date | null;
  role: string | null;
  expires_at: string | Date | null;
  joined_at: string | Date | null;
}

function profileOf(row: ProfileRow): PartnerProfile {
  return {
    businessName: row.business_name,
    website: row.website,
    referralCode: row.referral_code,
    joinedAt: new Date(row.created_at),
  };
}

function websiteOk(website: string): boolean {
  if (website.length > PARTNER_LIMITS.website) return false;
  try {
    const url = new URL(website);
    return url.protocol === 'https:' && url.hostname.includes('.') && !url.username;
  } catch {
    return false;
  }
}

function referralCode(): string {
  return Array.from({ length: 8 }, () => CODE_LETTERS[randomInt(CODE_LETTERS.length)]).join('');
}
