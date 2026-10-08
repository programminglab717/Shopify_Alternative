import {
  DnsLookup,
  PlanAllowance,
  StorefrontSite,
  failOne,
  planFeatureMessage,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import { Database, type Tx } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import { newId } from '@hatti/ids';
import { Injectable, Optional } from '@nestjs/common';
import { and, asc, count, desc, eq, isNotNull, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { DOMAIN_LIMIT, hostOf, sameHost } from './domain-name.js';
import {
  OnlineStoreEvents,
  type DomainChangedPayload,
  type DomainUnpointedPayload,
  type DomainUpdatedPayload,
} from './events.js';
import type { DomainRecord } from './records.js';
import { domains, type DomainRow } from './schema.js';

/** What DNS said of a domain: whether it points at the platform, and what it names if not. */
interface Pointing {
  ok: boolean;
  found: string[];
}

/** How long a verified domain goes before the worker asks DNS about it again (ADR-262). */
export const DOMAIN_CHECK_HOURS = 6;

/**
 * How long DNS may point a verified domain elsewhere before it is disconnected (ADR-262): longer
 * than DNS takes to change, so a shop moving its DNS, or fixing a mistake, keeps its domain.
 */
export const DOMAIN_GRACE_HOURS = 72;

/**
 * What came of asking DNS about a domain again (ADR-262): still pointed at the platform; pointed
 * elsewhere, for less than {@link DOMAIN_GRACE_HOURS} hours; disconnected; DNS not answering; or
 * nothing asked, the domain let go or not verified.
 */
export type DomainCheck = 'pointed' | 'unpointed' | 'disconnected' | 'unanswered' | 'skipped';

/**
 * A shop's own domains (ADR-048), such as www.zari.pk: each one shop's on the whole platform,
 * pointed at the platform with a CNAME record, checked when the shop asks, and then served by its
 * storefront, checked again by the worker every few hours (ADR-262). The primary one, which must
 * have been checked, is where the storefront sends shoppers; without one, the shop's address on
 * the platform's domain is.
 */
@Injectable()
export class DomainService {
  constructor(
    private readonly db: Database,
    private readonly storefronts: StorefrontSite,
    private readonly dns: DnsLookup,
    /** Whether the shop's plan includes a domain of its own (ADR-264); without it, any does. */
    @Optional() private readonly allowance?: PlanAllowance,
  ) {}

  /** Where a shop points a domain of its own: a CNAME record naming this host. */
  get dnsTarget(): string {
    return this.storefronts.dnsTarget;
  }

  /** The shop's domains, the primary first, then as they were added. */
  async list(tenant: TenantContext): Promise<DomainRecord[]> {
    return this.db.tenant(tenant.shopId, (tx) => this.domainsOf(tx, tenant.shopId));
  }

  async get(tenant: TenantContext, id: string): Promise<DomainRecord | null> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const row = await this.#find(tx, tenant.shopId, id);
      return row ? toRecord(row) : null;
    });
  }

  /**
   * Connects a domain, as a shop types it: served once it is checked. Records `domain.created`.
   * Refused on a plan without domains of the shop's own, which keeps those connected before.
   */
  async create(
    tenant: TenantContext,
    input: { host: string },
  ): Promise<MutationResult<DomainRecord>> {
    const host = hostOf(input.host);
    if (!host) {
      return failOne(['host'], 'INVALID', 'Enter a domain, such as www.zarifashions.pk');
    }
    if (this.storefronts.isPlatformHost(host) || sameHost(host, this.dnsTarget)) {
      return failOne(['host'], 'INVALID', `${host} is Hatti's: enter a domain of the shop's own`);
    }
    const plan = await this.allowance?.excludes(tenant.shopId, 'customDomains');
    if (plan) {
      return failOne(['host'], 'INVALID', planFeatureMessage(plan, "a domain of the shop's own"));
    }
    return this.db.tenant(tenant.shopId, async (tx) => {
      const [counts] = await tx
        .select({ total: count() })
        .from(domains)
        .where(eq(domains.shopId, tenant.shopId));
      if ((counts?.total ?? 0) >= DOMAIN_LIMIT) {
        return failOne([], 'TOO_MANY', `A shop can connect at most ${DOMAIN_LIMIT} domains`);
      }
      // The host is unique across shops, whichever shop has it: the index sees them all.
      const [row] = await tx
        .insert(domains)
        .values({ shopId: tenant.shopId, id: newId(), host })
        .onConflictDoNothing()
        .returning();
      if (!row) return failOne(['host'], 'TAKEN', `${host} is connected to a shop already`);
      await this.#recordEvent<DomainChangedPayload>(tx, OnlineStoreEvents.DomainCreated, row, {});
      return { ok: true, value: toRecord(row) };
    });
  }

  /**
   * Asks DNS whether the domain points at the platform, and marks it verified when it does, as
   * pointing from now on: one the worker found pointing elsewhere (ADR-262) too, or disconnected.
   * Records `domain.updated` when it was not verified before.
   */
  async verify(tenant: TenantContext, id: string): Promise<MutationResult<DomainRecord>> {
    const row = await this.db.tenant(tenant.shopId, (tx) => this.#find(tx, tenant.shopId, id));
    if (!row) return failOne(['id'], 'NOT_FOUND', 'Domain not found');
    // Outside the transaction: DNS may take seconds to answer.
    let pointing: Pointing;
    try {
      pointing = await this.#pointing(row.host);
    } catch {
      return failOne(
        ['id'],
        'UNAVAILABLE',
        'DNS could not be asked just now: try again in a minute',
      );
    }
    if (!pointing.ok) {
      const where =
        pointing.found.length > 0
          ? `points at ${pointing.found.join(', ')}, not at ${this.dnsTarget}`
          : `is not pointed at ${this.dnsTarget}`;
      return failOne(
        ['id'],
        'NOT_POINTED',
        `${row.host} ${where}: add a CNAME record naming ${this.dnsTarget}, and check again ` +
          'once DNS has it',
      );
    }
    return this.db.tenant(tenant.shopId, async (tx) => {
      const [updated] = await tx
        .update(domains)
        .set({
          verifiedAt: sql`now()`,
          checkedAt: sql`now()`,
          unpointedSince: null,
          updatedAt: sql`now()`,
        })
        .where(and(eq(domains.shopId, tenant.shopId), eq(domains.id, id)))
        .returning();
      if (!updated) return failOne(['id'], 'NOT_FOUND', 'Domain not found');
      if (row.verifiedAt === null) {
        await this.#recordUpdate(tx, updated, ['isVerified']);
      }
      return { ok: true, value: toRecord(updated) };
    });
  }

  /**
   * Makes the domain the shop's primary one, which must be verified, or makes it primary no
   * more, the platform's address taking its place. Records `domain.updated` for each that
   * changed.
   */
  async update(
    tenant: TenantContext,
    id: string,
    input: { isPrimary?: boolean | null },
  ): Promise<MutationResult<DomainRecord>> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const row = await this.#find(tx, tenant.shopId, id, { lock: true });
      if (!row) return failOne(['id'], 'NOT_FOUND', 'Domain not found');
      const primary = input.isPrimary ?? row.isPrimary;
      if (primary === row.isPrimary) return { ok: true, value: toRecord(row) };
      // Nor one DNS points elsewhere (ADR-262): shoppers sent there would find another site.
      if (primary && (row.verifiedAt === null || row.unpointedSince !== null)) {
        return failOne(
          ['isPrimary'],
          'NOT_POINTED',
          `${row.host} must point at ${this.dnsTarget} before it is primary: check it first`,
        );
      }
      if (primary) {
        // The one primary until now first: a shop has one at most.
        const before = await tx
          .update(domains)
          .set({ isPrimary: false, updatedAt: sql`now()` })
          .where(and(eq(domains.shopId, tenant.shopId), eq(domains.isPrimary, true)))
          .returning();
        for (const other of before) {
          await this.#recordUpdate(tx, other, ['isPrimary']);
        }
      }
      const [updated] = await tx
        .update(domains)
        .set({ isPrimary: primary, updatedAt: sql`now()` })
        .where(and(eq(domains.shopId, tenant.shopId), eq(domains.id, id)))
        .returning();
      await this.#recordUpdate(tx, updated!, ['isPrimary']);
      return { ok: true, value: toRecord(updated!) };
    });
  }

  /**
   * The verified domains due to be asked about again (ADR-262), across shops, through the system
   * login: those not asked for {@link DOMAIN_CHECK_HOURS} hours, the longest first, `limit` at
   * most.
   */
  async domainsToCheck(limit: number): Promise<{ shopId: string; id: string }[]> {
    return this.db.system((tx) =>
      tx
        .select({ shopId: domains.shopId, id: domains.id })
        .from(domains)
        .where(
          and(
            isNotNull(domains.verifiedAt),
            or(
              isNull(domains.checkedAt),
              lt(domains.checkedAt, sql`now() - make_interval(hours => ${DOMAIN_CHECK_HOURS})`),
            ),
          ),
        )
        .orderBy(sql`${domains.checkedAt} NULLS FIRST`)
        .limit(limit),
    );
  }

  /**
   * Asks DNS again about a verified domain (ADR-262). Still pointed at the platform, it is checked
   * now. Pointed elsewhere, it is noted from when, with `domain.unpointed` the first time, which
   * tells the shop; {@link DOMAIN_GRACE_HOURS} hours on, it is disconnected, verified no more and
   * primary no more, with `domain.updated`, and the storefront sends shoppers to the shop's
   * address on the platform's domain in its place. DNS that cannot be asked changes nothing but
   * when it was asked.
   */
  async recheck(shopId: string, id: string): Promise<DomainCheck> {
    const row = await this.db.tenant(shopId, (tx) => this.#find(tx, shopId, id));
    if (!row || row.verifiedAt === null) return 'skipped';
    // Outside the transaction: DNS may take seconds to answer.
    let pointing: Pointing | null = null;
    try {
      pointing = await this.#pointing(row.host);
    } catch {
      // Asked again at the next check, as if it had answered.
    }
    return this.db.tenant(shopId, async (tx): Promise<DomainCheck> => {
      const current = await this.#find(tx, shopId, id, { lock: true });
      // Let go, or checked by the shop and refused, since.
      if (!current || current.verifiedAt === null) return 'skipped';
      const where = and(eq(domains.shopId, shopId), eq(domains.id, id));
      if (!pointing) {
        await tx
          .update(domains)
          .set({ checkedAt: sql`now()` })
          .where(where);
        return 'unanswered';
      }
      if (pointing.ok) {
        await tx
          .update(domains)
          .set({
            checkedAt: sql`now()`,
            verifiedAt: sql`now()`,
            unpointedSince: null,
            ...(current.unpointedSince ? { updatedAt: sql`now()` } : {}),
          })
          .where(where);
        return 'pointed';
      }
      if (current.unpointedSince === null) {
        const [unpointed] = await tx
          .update(domains)
          .set({ checkedAt: sql`now()`, unpointedSince: sql`now()`, updatedAt: sql`now()` })
          .where(where)
          .returning();
        const since = unpointed!.unpointedSince!.getTime();
        await this.#recordEvent<DomainUnpointedPayload>(
          tx,
          OnlineStoreEvents.DomainUnpointed,
          unpointed!,
          { disconnectAt: new Date(since + DOMAIN_GRACE_HOURS * 3_600_000).toISOString() },
        );
        return 'unpointed';
      }
      const [disconnected] = await tx
        .update(domains)
        .set({ checkedAt: sql`now()`, verifiedAt: null, isPrimary: false, updatedAt: sql`now()` })
        .where(
          and(
            where,
            lte(domains.unpointedSince, sql`now() - make_interval(hours => ${DOMAIN_GRACE_HOURS})`),
          ),
        )
        .returning();
      if (!disconnected) {
        await tx
          .update(domains)
          .set({ checkedAt: sql`now()` })
          .where(where);
        return 'unpointed';
      }
      await this.#recordUpdate(
        tx,
        disconnected,
        current.isPrimary ? ['isVerified', 'isPrimary'] : ['isVerified'],
      );
      return 'disconnected';
    });
  }

  /** Lets the domain go: the storefront no longer answers at it. Records `domain.deleted`. */
  async delete(tenant: TenantContext, id: string): Promise<MutationResult<{ id: string }>> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const [row] = await tx
        .delete(domains)
        .where(and(eq(domains.shopId, tenant.shopId), eq(domains.id, id)))
        .returning();
      if (!row) return failOne(['id'], 'NOT_FOUND', 'Domain not found');
      await this.#recordEvent<DomainChangedPayload>(tx, OnlineStoreEvents.DomainDeleted, row, {});
      return { ok: true, value: { id } };
    });
  }

  /**
   * The shop's domains, the primary first, in the caller's transaction `tx`: for read models
   * built outside the module, such as the storefront's.
   */
  domainsOf(tx: Tx, shopId: string): Promise<DomainRecord[]> {
    return shopDomainsOf(tx, shopId);
  }

  /** The shop's primary domain's host, if it has one, in the caller's transaction `tx`. */
  async primaryOf(tx: Tx, shopId: string): Promise<string | null> {
    const [row] = await tx
      .select({ host: domains.host })
      .from(domains)
      .where(and(eq(domains.shopId, shopId), eq(domains.isPrimary, true)));
    return row?.host ?? null;
  }

  /**
   * Whether DNS points `host` at the platform: a CNAME record naming the target, or, at a
   * domain's apex, where DNS providers flatten one, the target's own addresses.
   */
  async #pointing(host: string): Promise<Pointing> {
    const target = this.dnsTarget;
    const cnames = await this.dns.cnames(host);
    if (cnames.some((name) => sameHost(name, target))) return { ok: true, found: cnames };
    if (cnames.length > 0) return { ok: false, found: cnames };
    const [mine, theirs] = await Promise.all([
      this.dns.addresses(host),
      this.dns.addresses(target),
    ]);
    const same = mine.length > 0 && mine.every((address) => theirs.includes(address));
    return { ok: same, found: mine };
  }

  /** Records `domain.updated`, naming the fields that changed. */
  #recordUpdate(tx: Tx, row: DomainRow, changed: string[]): Promise<void> {
    return this.#recordEvent<DomainUpdatedPayload>(tx, OnlineStoreEvents.DomainUpdated, row, {
      changed,
    });
  }

  async #recordEvent<P extends DomainChangedPayload>(
    tx: Tx,
    type: string,
    row: DomainRow,
    extra: Omit<P, keyof DomainChangedPayload>,
  ): Promise<void> {
    await appendEvent<P>(tx, row.shopId, {
      type,
      aggregateType: 'domain',
      aggregateId: row.id,
      payload: {
        host: row.host,
        isVerified: row.verifiedAt !== null,
        isPrimary: row.isPrimary,
        ...extra,
      } as P,
    });
  }

  async #find(
    tx: Tx,
    shopId: string,
    id: string,
    options: { lock?: boolean } = {},
  ): Promise<DomainRow | undefined> {
    const query = tx
      .select()
      .from(domains)
      .where(and(eq(domains.shopId, shopId), eq(domains.id, id)));
    const [row] = options.lock ? await query.for('update') : await query;
    return row;
  }
}

/**
 * The shop's domains, the primary first, in the caller's transaction `tx`: what
 * {@link DomainService.domainsOf} gives, for read models built where DNS is not asked.
 */
export async function shopDomainsOf(tx: Tx, shopId: string): Promise<DomainRecord[]> {
  const rows = await tx
    .select()
    .from(domains)
    .where(eq(domains.shopId, shopId))
    .orderBy(desc(domains.isPrimary), asc(domains.id));
  return rows.map(toRecord);
}

function toRecord(row: DomainRow): DomainRecord {
  return {
    id: row.id,
    host: row.host,
    verifiedAt: row.verifiedAt,
    isPrimary: row.isPrimary,
    unpointedSince: row.unpointedSince,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
