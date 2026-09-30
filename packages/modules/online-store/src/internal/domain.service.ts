import {
  DnsLookup,
  StorefrontSite,
  failOne,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import { Database, type Tx } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import { newId } from '@hatti/ids';
import { Injectable } from '@nestjs/common';
import { and, asc, count, desc, eq, sql } from 'drizzle-orm';
import { DOMAIN_LIMIT, hostOf, sameHost } from './domain-name.js';
import {
  OnlineStoreEvents,
  type DomainChangedPayload,
  type DomainUpdatedPayload,
} from './events.js';
import type { DomainRecord } from './records.js';
import { domains, type DomainRow } from './schema.js';

/** What DNS said of a domain: whether it points at the platform, and what it names if not. */
interface Pointing {
  ok: boolean;
  found: string[];
}

/**
 * A shop's own domains (ADR-048), such as www.zari.pk: each one shop's on the whole platform,
 * pointed at the platform with a CNAME record, checked when the shop asks, and then served by its
 * storefront. The primary one, which must have been checked, is where the storefront sends
 * shoppers; without one, the shop's address on the platform's domain is.
 */
@Injectable()
export class DomainService {
  constructor(
    private readonly db: Database,
    private readonly storefronts: StorefrontSite,
    private readonly dns: DnsLookup,
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
   * Asks DNS whether the domain points at the platform, and marks it verified when it does. One
   * that stops pointing stays as it was, until it is checked again. Records `domain.updated` the
   * first time.
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
        .set({ verifiedAt: sql`now()`, updatedAt: sql`now()` })
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
      if (primary && row.verifiedAt === null) {
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
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
