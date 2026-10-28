import {
  InputChecker,
  StorefrontSite,
  failOne,
  shopProfile,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import { Database, isUniqueViolation, type Tx } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import { newId } from '@hatti/ids';
import { ObjectStorage } from '@hatti/storage';
import { Injectable, Optional } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { OrderEvents, type AffiliateChangedPayload, type AffiliatePaidPayload } from './events.js';
import { linkShopIn } from './link-shop.js';
import { linkHashOf, newLinkToken, type LinkShop } from './links.js';
import { affiliatePayouts, affiliates, type AffiliateRow } from './schema.js';

/** Where affiliates' own pages are: /a/<secret> (ADR-899). */
export const AFFILIATE_PAGE_PATH = 'a';

/** What an affiliate's own page shows (ADR-899): nothing of their customers. */
export type AffiliatePageView =
  | { kind: 'not_found' }
  | {
      kind: 'page';
      shop: LinkShop;
      currency: string;
      name: string;
      /** Their link to the shop's storefront; null without a storefront to name. */
      link: string | null;
      discountCode: string | null;
      commissionBps: number;
      ended: boolean;
      stats: AffiliateStats;
      orders: Omit<AffiliateOrderRecord, 'orderId'>[];
    };

/** What the shop keeps of its affiliates, at most. */
export const AFFILIATE_LIMITS = {
  perShop: 500,
  name: 100,
  note: 200,
  /** The largest share an affiliate earns, in percent. */
  percent: 50,
  /** How many of an affiliate's orders, and of its payouts, a page shows, the latest first. */
  latest: 50,
} as const;

/** What an affiliate's link carries after ?ref=: lower case, letters, digits and hyphens. */
const REF = /^[a-z0-9][a-z0-9-]{1,39}$/;
/** A discount code, as the shop's codes are written, upper case as orders keep them. */
const CODE = /^[A-Z0-9_-]{1,50}$/;
/** A share in percent, to two places: "10", "7.5" or "12.25". */
const PERCENT = /^\d{1,2}(\.\d{1,2})?$/;

/** Someone who sends the shop customers by a link or code of their own (MKT-08, ADR-776). */
export interface AffiliateRecord {
  id: string;
  name: string;
  /** In E.164; null where the shop keeps none. */
  phone: string | null;
  /** What their link carries after ?ref=. */
  ref: string;
  /** One of the shop's discount codes, upper case; null for a link alone. */
  discountCode: string | null;
  /** Their share of what an order's items came to, in hundredths of a percent. */
  commissionBps: number;
  /** When the shop ended their part; null while it lasts. */
  endedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** What an affiliate's orders came to, worked out from the orders when asked. */
export interface AffiliateStats {
  /** Orders they brought, cancelled ones aside. */
  orders: number;
  /** Of those, the ones delivered, which earn. */
  delivered: number;
  /** What the delivered orders' items came to, after discounts and refunds, in minor units. */
  sales: bigint;
  /** Their share of `sales`. */
  earned: bigint;
  /** Their share of the orders still on their way, earned once delivered. */
  pending: bigint;
  /** What the shop recorded paying them. */
  paid: bigint;
  /** What is earned and not paid; below zero where the shop paid ahead. */
  owed: bigint;
}

export interface AffiliateReport extends AffiliateRecord {
  stats: AffiliateStats;
}

/** One of an affiliate's orders, with what it earns them. */
export interface AffiliateOrderRecord {
  orderId: string;
  number: number;
  placedAt: Date;
  stage: string;
  /** How it came to them: by their code, or their link. */
  by: 'code' | 'link';
  /** What its items came to, after discounts and refunds, in minor units. */
  base: bigint;
  /** Their share of `base`: earned once delivered, nothing if it comes back. */
  commission: bigint;
}

export interface AffiliatePayoutRecord {
  id: string;
  affiliateId: string;
  amount: bigint;
  note: string;
  paidAt: Date;
}

export interface AffiliateInput {
  name: string;
  phone?: string | null;
  ref: string;
  discountCode?: string | null;
  /** In percent, to two places: "10" or "7.5". */
  commission: string;
}

/** Fields left out stay as they are; a blank phone or code takes it off. */
export interface AffiliateUpdateInput {
  name?: string | null;
  phone?: string | null;
  ref?: string | null;
  discountCode?: string | null;
  commission?: string | null;
  /** False ends their part from now: orders placed after it earn them nothing. */
  active?: boolean | null;
}

export interface AffiliatePayoutInput {
  affiliateId: string;
  /** In major units, as the shop writes it: "2500" or "2500.50". */
  amount: string;
  note?: string | null;
}

interface StatsRow extends Record<string, unknown> {
  affiliate_id: string;
  orders: number;
  delivered: number;
  sales: string;
  earned: string;
  pending: string;
}

interface OrderRow extends Record<string, unknown> {
  order_id: string;
  number: number;
  placed_at: Date | string;
  stage: string;
  priority: number;
  base: string;
  commission: string;
}

/** Stages in which an order has reached its customer, and earns. */
const DELIVERED = ['delivered', 'completed'];
/** Stages in which an order will earn nothing: it came back, was lost or was cancelled. */
const ENDED = ['returned', 'lost', 'cancelled'];

function toAffiliateRecord(row: AffiliateRow): AffiliateRecord {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    ref: row.ref,
    discountCode: row.discountCode,
    commissionBps: row.commissionBps,
    endedAt: row.endedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Affiliates and influencers (MKT-08, ADR-776): people who send the shop customers by a link of
 * their own (the storefront with ?ref=) or one of its discount codes, and earn a share of what
 * the orders they bring came to once delivered. Which orders are theirs is worked out from the
 * orders when asked, nothing stored: an order placed with their code is theirs, and otherwise one
 * whose last visit, or first, began at their link; only orders placed while their part lasts
 * count. The shop records what it pays them; what is owed is what is earned less what is paid.
 */
@Injectable()
export class AffiliatesService {
  constructor(
    private readonly db: Database,
    /** For the shop's logo on affiliates' pages; without it, its name. */
    @Optional() private readonly storage?: ObjectStorage,
    /** For their link on their page; without it, none. */
    @Optional() private readonly storefronts?: StorefrontSite,
  ) {}

  /**
   * A new secret link to an affiliate's own page (ADR-899), the one before it no longer
   * working: its path, /a/<secret>, for the shop to send them. Hatti keeps its digest alone.
   */
  async pageLink(tenant: TenantContext, id: string): Promise<MutationResult<string>> {
    const { token, hash } = newLinkToken();
    return this.db.tenant(tenant.shopId, async (tx) => {
      const [row] = await tx
        .update(affiliates)
        .set({ pageTokenHash: hash, updatedAt: sql`now()` })
        .where(and(eq(affiliates.shopId, tenant.shopId), eq(affiliates.id, id)))
        .returning({ id: affiliates.id });
      if (!row) return failOne(['id'], 'NOT_FOUND', 'Affiliate not found');
      await appendEvent<AffiliateChangedPayload>(tx, tenant.shopId, {
        type: OrderEvents.AffiliateUpdated,
        aggregateType: 'affiliate',
        aggregateId: id,
        payload: { changed: ['pageLink'] },
      });
      return { ok: true, value: `/${AFFILIATE_PAGE_PATH}/${token}` };
    });
  }

  /** What the affiliate behind a page's secret sees (ADR-899), as it is now. */
  async page(token: string): Promise<AffiliatePageView> {
    const hash = linkHashOf(token);
    if (!hash) return { kind: 'not_found' };
    const { rows } = await this.db.app.execute<{ shop_id: string; affiliate_id: string }>(
      sql`SELECT * FROM orders.resolve_affiliate_page(${hash})`,
    );
    const found = rows[0];
    if (!found) return { kind: 'not_found' };
    const tenant = { shopId: found.shop_id } as TenantContext;
    const report = (await this.list(tenant)).find((each) => each.id === found.affiliate_id);
    if (!report) return { kind: 'not_found' };
    const orders = await this.orders(tenant, report.id);
    return this.db.tenant(found.shop_id, async (tx) => {
      const profile = await shopProfile(tx, found.shop_id);
      return {
        kind: 'page' as const,
        shop: await linkShopIn(tx, found.shop_id, this.storage),
        currency: profile.currency,
        name: report.name,
        link: this.storefronts
          ? `${this.storefronts.url(profile.handle)}/?ref=${report.ref}`
          : null,
        discountCode: report.discountCode,
        commissionBps: report.commissionBps,
        ended: report.endedAt !== null,
        stats: report.stats,
        orders: orders.map(({ orderId: _orderId, ...order }) => order),
      };
    });
  }

  async create(
    tenant: TenantContext,
    input: AffiliateInput,
  ): Promise<MutationResult<AffiliateRecord>> {
    const check = new InputChecker();
    const name = checkName(check, input.name);
    const phone = check.mobile(['input', 'phone'], input.phone);
    const ref = checkRef(check, input.ref);
    const discountCode = checkCode(check, input.discountCode);
    const commissionBps = checkCommission(check, input.commission);
    if (!check.ok || !name || !ref || commissionBps === null) {
      return { ok: false, errors: check.errors };
    }
    return this.#unique(() =>
      this.db.tenant(tenant.shopId, async (tx) => {
        // Counted under a lock, so that two added at once can't both pass the limit.
        await lockAffiliates(tx, tenant.shopId);
        const [kept] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(affiliates)
          .where(eq(affiliates.shopId, tenant.shopId));
        if (kept!.count >= AFFILIATE_LIMITS.perShop) {
          return failOne(
            ['input'],
            'TOO_MANY',
            `A shop keeps at most ${AFFILIATE_LIMITS.perShop} affiliates`,
          );
        }
        const [row] = await tx
          .insert(affiliates)
          .values({
            shopId: tenant.shopId,
            id: newId(),
            name,
            phone,
            ref,
            discountCode,
            commissionBps,
          })
          .returning();
        await appendEvent<AffiliateChangedPayload>(tx, tenant.shopId, {
          type: OrderEvents.AffiliateCreated,
          aggregateType: 'affiliate',
          aggregateId: row!.id,
          payload: { changed: [] },
        });
        return { ok: true, value: toAffiliateRecord(row!) };
      }),
    );
  }

  async update(
    tenant: TenantContext,
    id: string,
    input: AffiliateUpdateInput,
  ): Promise<MutationResult<AffiliateRecord>> {
    const check = new InputChecker();
    const changes: Partial<
      Pick<AffiliateRow, 'name' | 'phone' | 'ref' | 'discountCode' | 'commissionBps'>
    > = {};
    if (input.name !== undefined) {
      const name = checkName(check, input.name);
      if (name) changes.name = name;
    }
    if (input.phone !== undefined) changes.phone = check.mobile(['input', 'phone'], input.phone);
    if (input.ref !== undefined) {
      const ref = checkRef(check, input.ref);
      if (ref) changes.ref = ref;
    }
    if (input.discountCode !== undefined) {
      changes.discountCode = checkCode(check, input.discountCode);
    }
    if (input.commission !== undefined) {
      const bps = checkCommission(check, input.commission);
      if (bps !== null) changes.commissionBps = bps;
    }
    if (!check.ok) return { ok: false, errors: check.errors };
    return this.#unique(() =>
      this.db.tenant(tenant.shopId, async (tx) => {
        const where = and(eq(affiliates.shopId, tenant.shopId), eq(affiliates.id, id));
        const [current] = await tx.select().from(affiliates).where(where).for('update');
        if (!current) return failOne(['input', 'id'], 'NOT_FOUND', 'Affiliate not found');
        const changed: string[] = (Object.keys(changes) as (keyof typeof changes)[]).filter(
          (key) => changes[key] !== current[key],
        );
        const set: Record<string, unknown> = Object.fromEntries(
          changed.map((key) => [key, changes[key as keyof typeof changes]]),
        );
        if (input.active === false && current.endedAt === null) {
          set.endedAt = sql`now()`;
          changed.push('active');
        } else if (input.active === true && current.endedAt !== null) {
          set.endedAt = null;
          changed.push('active');
        }
        if (changed.length === 0) return { ok: true, value: toAffiliateRecord(current) };
        const [row] = await tx
          .update(affiliates)
          .set({ ...set, updatedAt: sql`now()` })
          .where(where)
          .returning();
        await appendEvent<AffiliateChangedPayload>(tx, tenant.shopId, {
          type: OrderEvents.AffiliateUpdated,
          aggregateType: 'affiliate',
          aggregateId: id,
          payload: { changed },
        });
        return { ok: true, value: toAffiliateRecord(row!) };
      }),
    );
  }

  /** The shop's affiliates, the latest added first, each with what their orders came to. */
  async list(tenant: TenantContext): Promise<AffiliateReport[]> {
    const { shopId } = tenant;
    return this.db.tenant(shopId, async (tx) => {
      const rows = await tx
        .select()
        .from(affiliates)
        .where(eq(affiliates.shopId, shopId))
        .orderBy(desc(affiliates.createdAt), desc(affiliates.id));
      if (rows.length === 0) return [];
      const { rows: stats } = await tx.execute<StatsRow>(sql`
        WITH matched AS (${matchedOrders(shopId)})
        SELECT affiliate_id,
               count(*)::int AS orders,
               count(*) FILTER (WHERE stage = ANY(${sql.param(DELIVERED)}::text[]))::int AS delivered,
               coalesce(sum(base) FILTER (WHERE stage = ANY(${sql.param(DELIVERED)}::text[])), 0)::text AS sales,
               coalesce(sum(commission) FILTER (WHERE stage = ANY(${sql.param(DELIVERED)}::text[])), 0)::text AS earned,
               coalesce(sum(commission) FILTER (
                 WHERE NOT stage = ANY(${sql.param([...DELIVERED, ...ENDED])}::text[])), 0)::text AS pending
          FROM matched
         GROUP BY affiliate_id`);
      const paid = await tx
        .select({
          affiliateId: affiliatePayouts.affiliateId,
          amount: sql<string>`sum(${affiliatePayouts.amount})::text`,
        })
        .from(affiliatePayouts)
        .where(eq(affiliatePayouts.shopId, shopId))
        .groupBy(affiliatePayouts.affiliateId);
      return rows.map((row) => {
        const counted = stats.find((each) => each.affiliate_id === row.id);
        const earned = BigInt(counted?.earned ?? 0);
        const paidOut = BigInt(paid.find((each) => each.affiliateId === row.id)?.amount ?? 0);
        return {
          ...toAffiliateRecord(row),
          stats: {
            orders: counted?.orders ?? 0,
            delivered: counted?.delivered ?? 0,
            sales: BigInt(counted?.sales ?? 0),
            earned,
            pending: BigInt(counted?.pending ?? 0),
            paid: paidOut,
            owed: earned - paidOut,
          },
        };
      });
    });
  }

  /** One affiliate; null if the shop has none by that ID. */
  async get(tenant: TenantContext, id: string): Promise<AffiliateRecord | null> {
    const [row] = await this.db.tenant(tenant.shopId, (tx) =>
      tx
        .select()
        .from(affiliates)
        .where(and(eq(affiliates.shopId, tenant.shopId), eq(affiliates.id, id))),
    );
    return row ? toAffiliateRecord(row) : null;
  }

  /** An affiliate's latest orders, with what each earns them. */
  async orders(tenant: TenantContext, id: string): Promise<AffiliateOrderRecord[]> {
    const { shopId } = tenant;
    const { rows } = await this.db.tenant(shopId, (tx) =>
      tx.execute<OrderRow>(sql`
        WITH matched AS (${matchedOrders(shopId)})
        SELECT order_id, number, placed_at, stage, priority, base::text, commission::text
          FROM matched
         WHERE affiliate_id = ${id}
         ORDER BY placed_at DESC, order_id DESC
         LIMIT ${AFFILIATE_LIMITS.latest}`),
    );
    return rows.map((row) => ({
      orderId: row.order_id,
      number: row.number,
      placedAt: new Date(row.placed_at),
      stage: row.stage,
      by: row.priority === 0 ? 'code' : 'link',
      base: BigInt(row.base),
      commission: BigInt(row.commission),
    }));
  }

  /** What the shop recorded paying an affiliate, the latest first. */
  async payouts(tenant: TenantContext, id: string): Promise<AffiliatePayoutRecord[]> {
    const rows = await this.db.tenant(tenant.shopId, (tx) =>
      tx
        .select()
        .from(affiliatePayouts)
        .where(
          and(eq(affiliatePayouts.shopId, tenant.shopId), eq(affiliatePayouts.affiliateId, id)),
        )
        .orderBy(desc(affiliatePayouts.paidAt), desc(affiliatePayouts.id))
        .limit(AFFILIATE_LIMITS.latest),
    );
    return rows.map(toPayoutRecord);
  }

  /** Records that the shop paid an affiliate, as it did it: by hand, by transfer or in cash. */
  async recordPayout(
    tenant: TenantContext,
    input: AffiliatePayoutInput,
  ): Promise<MutationResult<AffiliatePayoutRecord>> {
    const check = new InputChecker();
    const amount = check.price(['input', 'amount'], input.amount, tenant.currency, {
      required: true,
    });
    if (amount === 0n) check.add(['input', 'amount'], 'INVALID', 'must be more than zero');
    const note = check.text(['input', 'note'], input.note, { max: AFFILIATE_LIMITS.note }) ?? '';
    if (!check.ok || amount === null) return { ok: false, errors: check.errors };
    return this.db.tenant(tenant.shopId, async (tx) => {
      const [affiliate] = await tx
        .select({ id: affiliates.id })
        .from(affiliates)
        .where(and(eq(affiliates.shopId, tenant.shopId), eq(affiliates.id, input.affiliateId)));
      if (!affiliate) {
        return failOne(['input', 'affiliateId'], 'NOT_FOUND', 'Affiliate not found');
      }
      const [row] = await tx
        .insert(affiliatePayouts)
        .values({
          shopId: tenant.shopId,
          id: newId(),
          affiliateId: affiliate.id,
          amount,
          note,
        })
        .returning();
      await appendEvent<AffiliatePaidPayload>(tx, tenant.shopId, {
        type: OrderEvents.AffiliatePaid,
        aggregateType: 'affiliate',
        aggregateId: affiliate.id,
        payload: { amount: amount.toString() },
      });
      return { ok: true, value: toPayoutRecord(row!) };
    });
  }

  /** A link or code another affiliate has is refused, whichever transaction gets there first. */
  async #unique(
    write: () => Promise<MutationResult<AffiliateRecord>>,
  ): Promise<MutationResult<AffiliateRecord>> {
    try {
      return await write();
    } catch (error) {
      if (isUniqueViolation(error, 'affiliates_ref_one')) {
        return failOne(['input', 'ref'], 'TAKEN', 'Another affiliate has this link');
      }
      if (isUniqueViolation(error, 'affiliates_code_one')) {
        return failOne(['input', 'discountCode'], 'TAKEN', 'Another affiliate has this code');
      }
      throw error;
    }
  }
}

function toPayoutRecord(row: typeof affiliatePayouts.$inferSelect): AffiliatePayoutRecord {
  return {
    id: row.id,
    affiliateId: row.affiliateId,
    amount: row.amount,
    note: row.note,
    paidAt: row.paidAt,
  };
}

/**
 * Each order of the shop's, cancelled ones aside, with the affiliate it is owed to, if any: the
 * one whose code it was placed with, or else whose link its last visit began at, or else its
 * first; placed while their part lasted. Its base is what its items came to after discounts and
 * refunds, and its commission their share of that, rounded down.
 */
function matchedOrders(shopId: string) {
  const refIn = (visit: 'first' | 'last') =>
    sql`lower(substring(o.attribution -> ${visit} ->> 'landingPage' FROM '[?&]ref=([A-Za-z0-9-]+)'))`;
  const byCode = sql`(a.discount_code IS NOT NULL
    AND a.discount_code IN (SELECT upper(code) FROM unnest(o.discount_codes) AS code))`;
  return sql`
    SELECT DISTINCT ON (o.id)
           o.id AS order_id, o.number, o.created_at AS placed_at, o.stage, a.id AS affiliate_id,
           CASE WHEN ${byCode} THEN 0 WHEN ${refIn('last')} = a.ref THEN 1 ELSE 2 END AS priority,
           GREATEST(o.subtotal - o.discount - o.amount_refunded, 0) AS base,
           GREATEST(o.subtotal - o.discount - o.amount_refunded, 0) * a.commission_bps / 10000
             AS commission
      FROM orders.orders o
      JOIN orders.affiliates a
        ON a.shop_id = o.shop_id
       AND o.created_at >= a.created_at
       AND (a.ended_at IS NULL OR o.created_at < a.ended_at)
       AND (${byCode} OR ${refIn('last')} = a.ref OR ${refIn('first')} = a.ref)
     WHERE o.shop_id = ${shopId} AND o.status <> 'cancelled'
     ORDER BY o.id, priority`;
}

function checkName(check: InputChecker, name: string | null | undefined): string | null {
  return check.text(['input', 'name'], name, { required: true, max: AFFILIATE_LIMITS.name });
}

function checkRef(check: InputChecker, value: string | null | undefined): string | null {
  const ref = value?.trim().toLowerCase() ?? '';
  if (!REF.test(ref)) {
    check.addMessage(
      ['input', 'ref'],
      'INVALID',
      'A link’s name is 2 to 40 letters, digits and hyphens, beginning with a letter or digit',
    );
    return null;
  }
  return ref;
}

function checkCode(check: InputChecker, value: string | null | undefined): string | null {
  const code = value?.trim().toUpperCase() ?? '';
  if (code === '') return null;
  if (!CODE.test(code)) {
    check.addMessage(
      ['input', 'discountCode'],
      'INVALID',
      'A discount code is up to 50 letters, digits, hyphens and underscores',
    );
    return null;
  }
  return code;
}

/** A share in percent, to two places, as hundredths of a percent. */
function checkCommission(check: InputChecker, value: string | null | undefined): number | null {
  const text = value?.trim() ?? '';
  const [whole = '0', part = ''] = text.split('.');
  const bps = PERCENT.test(text) ? Number(whole) * 100 + Number(part.padEnd(2, '0')) : 0;
  if (bps < 1 || bps > AFFILIATE_LIMITS.percent * 100) {
    check.addMessage(
      ['input', 'commission'],
      'INVALID',
      `An affiliate’s share is more than 0% and at most ${AFFILIATE_LIMITS.percent}%, to two places`,
    );
    return null;
  }
  return bps;
}

/** Holds the shop's affiliates still while one is added, for the count. */
async function lockAffiliates(tx: Tx, shopId: string): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`affiliates:${shopId}`}, 0))`,
  );
}
