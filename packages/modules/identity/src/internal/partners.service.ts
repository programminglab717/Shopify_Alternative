import { randomInt } from 'node:crypto';
import { MFA_REQUIRED_ROLES, isStaffRole, type StaffRole } from '@hatti/api';
import type { Db } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import { newId, toPublicId } from '@hatti/ids';
import { sql } from 'drizzle-orm';
import { recordShopAgreement, shopAgreement, type AgreedVersions } from './agreements.js';
import { AuthError } from './errors.js';
import type { AuthenticatedSession, ClientInfo, OpenedShop } from './identity.service.js';
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
  payoutTitle: 120,
  /** The share of each plan invoice a store they brought pays that a partner earns (ADR-505). */
  sharePercent: 20,
  /** Earnings listed on the dashboard, the newest first. */
  earningsListed: 50,
} as const;

/** A Pakistani IBAN, as the bank prints it, spaces taken out: PK, 2 digits, 4 letters, 16 digits. */
const IBAN = /^PK[0-9]{2}[A-Z]{4}[0-9]{16}$/;

export interface PartnerProfile {
  businessName: string;
  website: string | null;
  /** For links that bring a store to the partner (PRT-02). */
  referralCode: string;
  /** The bank account Hatti pays their share into (ADR-505); null until they give one. */
  payout: { title: string; iban: string } | null;
  joinedAt: Date;
}

/** What a partner earned of the stores they brought, in paisa (ADR-505). */
export interface PartnerEarnings {
  earned: bigint;
  paidOut: bigint;
  owed: bigint;
  /** The latest, the newest first. */
  entries: {
    shopName: string;
    invoiceNumber: string;
    plan: string;
    invoiceAmount: bigint;
    sharePercent: number;
    amount: bigint;
    earnedAt: Date;
    paidOutAt: Date | null;
    payoutReference: string | null;
  }[];
}

/** A partner Hatti owes, for Hatti's people to pay (ADR-505). */
export interface PartnerOwed {
  userId: string;
  businessName: string;
  email: string;
  payout: { title: string; iban: string } | null;
  owed: bigint;
  entries: number;
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
      SELECT business_name, website, referral_code, payout_title, payout_iban, created_at
        FROM identity.partners WHERE user_id = ${auth.userId}`);
    return rows[0] ? profileOf(rows[0]) : null;
  }

  /**
   * Joins the partner programme, or changes the partner's details: their business's name and its
   * website, https. A referral code is given on joining, and kept.
   */
  async join(
    auth: Pick<AuthenticatedSession, 'userId'>,
    input: {
      businessName: string;
      website?: string | null;
      payoutTitle?: string | null;
      payoutIban?: string | null;
    },
  ): Promise<PartnerProfile> {
    const businessName = input.businessName.replace(/\p{Cc}/gu, '').trim();
    const website = input.website?.trim() || null;
    const payoutTitle = input.payoutTitle?.replace(/\p{Cc}/gu, '').trim() || null;
    const payoutIban = input.payoutIban?.replace(/[\s-]/g, '').toUpperCase() || null;
    const fields: Record<string, string> = {};
    if (payoutTitle !== null && payoutTitle.length > PARTNER_LIMITS.payoutTitle) {
      fields.payoutTitle = `The account's title, in ${PARTNER_LIMITS.payoutTitle} characters or fewer`;
    }
    if (payoutIban !== null && !IBAN.test(payoutIban)) {
      fields.payoutIban = 'Give the IBAN as your bank prints it: PK, then 22 letters and digits';
    }
    if ((payoutTitle === null) !== (payoutIban === null)) {
      fields[payoutTitle === null ? 'payoutTitle' : 'payoutIban'] =
        'Give the account title and its IBAN together';
    }
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
          INSERT INTO identity.partners
                 (user_id, business_name, website, referral_code, payout_title, payout_iban)
               VALUES (${auth.userId}, ${businessName}, ${website}, ${referralCode()},
                       ${payoutTitle}, ${payoutIban})
          ON CONFLICT (user_id) DO UPDATE
                SET business_name = EXCLUDED.business_name, website = EXCLUDED.website,
                    payout_title = EXCLUDED.payout_title, payout_iban = EXCLUDED.payout_iban,
                    updated_at = now()
          RETURNING business_name, website, referral_code, payout_title, payout_iban,
                    created_at`);
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
   * What the partner earned of the stores they brought (ADR-505): in all, paid out and still
   * owed, and the latest of each plan invoice's share, the newest first.
   */
  async earnings(auth: Pick<AuthenticatedSession, 'userId'>): Promise<PartnerEarnings> {
    await this.#partner(this.db, auth.userId);
    const [totals, entries] = await Promise.all([
      this.db.execute<{ earned: string; paid_out: string }>(sql`
        SELECT coalesce(sum(amount), 0)::text AS earned,
               coalesce(sum(amount) FILTER (WHERE paid_out_at IS NOT NULL), 0)::text AS paid_out
          FROM identity.partner_earnings WHERE partner_id = ${auth.userId}`),
      this.db.execute<EarningRow>(sql`
        SELECT s.name AS shop_name, e.invoice_number::text, e.plan, e.invoice_amount::text,
               e.share_percent, e.amount::text, e.earned_at, e.paid_out_at, e.payout_reference
          FROM identity.partner_earnings e JOIN control.shops s ON s.id = e.shop_id
         WHERE e.partner_id = ${auth.userId}
         ORDER BY e.earned_at DESC, e.id DESC
         LIMIT ${PARTNER_LIMITS.earningsListed}`),
    ]);
    const earned = BigInt(totals.rows[0]?.earned ?? '0');
    const paidOut = BigInt(totals.rows[0]?.paid_out ?? '0');
    return {
      earned,
      paidOut,
      owed: earned - paidOut,
      entries: entries.rows.map((row) => ({
        shopName: row.shop_name,
        invoiceNumber: row.invoice_number,
        plan: row.plan,
        invoiceAmount: BigInt(row.invoice_amount),
        sharePercent: row.share_percent,
        amount: BigInt(row.amount),
        earnedAt: new Date(row.earned_at),
        paidOutAt: row.paid_out_at ? new Date(row.paid_out_at) : null,
        payoutReference: row.payout_reference,
      })),
    };
  }

  /** For Hatti's people (ADR-505): each partner owed something, the most owed first. */
  async owed(): Promise<PartnerOwed[]> {
    const { rows } = await this.db.execute<OwedRow>(sql`
      SELECT p.user_id, p.business_name, u.email, p.payout_title, p.payout_iban,
             sum(e.amount)::text AS owed, count(*)::int AS entries
        FROM identity.partner_earnings e
        JOIN identity.partners p ON p.user_id = e.partner_id
        JOIN identity.users u ON u.id = p.user_id
       WHERE e.paid_out_at IS NULL
       GROUP BY p.user_id, u.email
      HAVING sum(e.amount) > 0
       ORDER BY sum(e.amount) DESC, p.user_id`);
    return rows.map((row) => ({
      userId: row.user_id,
      businessName: row.business_name,
      email: row.email,
      payout:
        row.payout_title && row.payout_iban
          ? { title: row.payout_title, iban: row.payout_iban }
          : null,
      owed: BigInt(row.owed),
      entries: row.entries,
    }));
  }

  /**
   * For Hatti's people (ADR-505): marks everything the partner was owed paid, by the transfer
   * named by `reference`. What it came to, in paisa; nothing where nothing was owed.
   */
  async payOut(partnerUserId: string, reference: string): Promise<bigint> {
    const ref = reference.trim();
    if (ref.length === 0 || ref.length > 100) {
      throw new AuthError(
        'INVALID_INPUT',
        422,
        "Name the transfer's reference, 1 to 100 characters",
      );
    }
    const { rows } = await this.db.execute<{ total: string | null }>(sql`
      WITH paid AS (
        UPDATE identity.partner_earnings
           SET paid_out_at = ${this.now()}, payout_reference = ${ref}
         WHERE partner_id = ${partnerUserId} AND paid_out_at IS NULL
        RETURNING amount)
      SELECT sum(amount)::text AS total FROM paid`);
    return BigInt(rows[0]?.total ?? '0');
  }

  /**
   * Opens a development store, which the partner owns while they build it (ADR-504): closed to
   * shoppers, its storefront saying it opens soon, until they hand it to its client. It counts
   * against none of the five shops an account may own; a partner builds 20 at once at most.
   */
  async openDevelopmentStore(
    auth: Pick<AuthenticatedSession, 'userId'>,
    input: { name: string; handle?: string | null; agreed?: AgreedVersions | null },
    client: ClientInfo = {},
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
      // The partner agrees as the store's owner while they build it (ADR-737).
      const agreement = shopAgreement(input.agreed);
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
      await recordShopAgreement(tx, shopId, auth.userId, agreement, client);
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
 * Records that the shop just opened came by the referral code `code` (ADR-505): the store its
 * partner's, as referred, unless the code is no partner's or the opener's own. Whether it was.
 */
export async function referredBy(
  tx: Tx,
  shopId: string,
  openerId: string,
  code: string,
): Promise<boolean> {
  const { rows } = await tx.execute(sql`
    INSERT INTO identity.partner_stores (shop_id, partner_id, kind)
    SELECT ${shopId}, user_id, 'referred' FROM identity.partners
     WHERE referral_code = ${code.trim().toLowerCase()} AND user_id <> ${openerId}
    RETURNING shop_id`);
  return rows.length > 0;
}

/**
 * Records the share a paid plan invoice of the shop of `tx` earns its partner (ADR-505), through
 * identity's function: once an invoice, and only where a partner brought the shop. The share in
 * paisa, or null for none.
 */
export async function recordPartnerEarning(
  tx: Pick<Tx, 'execute'>,
  shopId: string,
  invoice: { id: string; number: string; plan: string; amount: bigint },
): Promise<bigint | null> {
  const { rows } = await tx.execute<{ amount: string | null }>(sql`
    SELECT identity.record_partner_earning(${shopId}, ${invoice.id}, ${invoice.number}::bigint,
                                           ${invoice.plan}, ${invoice.amount.toString()}::bigint)::text
           AS amount`);
  const amount = rows[0]?.amount;
  return amount === null || amount === undefined ? null : BigInt(amount);
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
  payout_title: string | null;
  payout_iban: string | null;
  created_at: string | Date;
}

interface EarningRow extends Record<string, unknown> {
  shop_name: string;
  invoice_number: string;
  plan: string;
  invoice_amount: string;
  share_percent: number;
  amount: string;
  earned_at: string | Date;
  paid_out_at: string | Date | null;
  payout_reference: string | null;
}

interface OwedRow extends Record<string, unknown> {
  user_id: string;
  business_name: string;
  email: string;
  payout_title: string | null;
  payout_iban: string | null;
  owed: string;
  entries: number;
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
    payout:
      row.payout_title && row.payout_iban
        ? { title: row.payout_title, iban: row.payout_iban }
        : null,
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
