import {
  InputChecker,
  StorefrontSite,
  fail,
  shopProfile,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import { Database, type Tx } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import { newId } from '@hatti/ids';
import { Injectable } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { DomainService } from './domain.service.js';
import { OnlineStoreEvents, type PolicyUpdatedPayload } from './events.js';
import { PAGE_LIMITS, cleanPageBody } from './page-body.js';
import { POLICY_TITLES, POLICY_TYPES, type PolicyType } from './policy-types.js';
import type { PolicyRecord, PolicyVersionRecord } from './records.js';
import { policies, policyVersions, translations, type PolicyRow } from './schema.js';
import { digestOf } from './translation-content.js';

export interface PolicyInput {
  type: PolicyType;
  /** HTML, cleaned of anything that could run before it is kept; blank takes the policy away. */
  body: string;
}

/**
 * A shop's policies, as Shopify keeps them (ADR-056): its refund, privacy, shipping and terms
 * policies and its contact information, one of each, HTML cleaned when saved as pages' bodies
 * are (ADR-045). The storefront shows them at /policies/{handle}. Every body saved is kept as a
 * version, so that orders can show what their customers agreed to (ADR-057).
 */
@Injectable()
export class PolicyService {
  constructor(
    private readonly db: Database,
    private readonly site: StorefrontSite,
    private readonly domains: DomainService,
  ) {}

  /** The policies the shop has, in Shopify's order. */
  async list(tenant: TenantContext): Promise<PolicyRecord[]> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const rows = await tx.select().from(policies).where(eq(policies.shopId, tenant.shopId));
      return inOrder(rows).map(toRecord);
    });
  }

  /**
   * The policy of `type` as given, or none once its body is blank. Records
   * `shop_policy.updated` if it changed.
   */
  async update(
    tenant: TenantContext,
    input: PolicyInput,
  ): Promise<MutationResult<PolicyRecord | null>> {
    const check = new InputChecker();
    const body = cleanPageBody(input.body);
    if (Buffer.byteLength(body) > PAGE_LIMITS.body) {
      check.addMessage(['body'], 'TOO_LONG', 'Body is too long (maximum is 512 KB)');
    }
    if (!check.ok) return fail(check.errors);
    return this.db.tenant(tenant.shopId, async (tx) => {
      const where = and(eq(policies.shopId, tenant.shopId), eq(policies.type, input.type));
      if (isBlank(body)) {
        const [gone] = await tx.delete(policies).where(where).returning();
        if (gone) await recordEvent(tx, gone.shopId, { type: input.type, removed: true });
        return { ok: true, value: null };
      }
      const [before] = await tx.select().from(policies).where(where).for('update');
      if (before?.body === body) return { ok: true, value: toRecord(before) };
      const versionId = newId();
      await tx
        .insert(policyVersions)
        .values({ shopId: tenant.shopId, id: versionId, type: input.type, body });
      const [row] = await tx
        .insert(policies)
        .values({ shopId: tenant.shopId, type: input.type, id: newId(), body, versionId })
        .onConflictDoUpdate({
          target: [policies.shopId, policies.type],
          set: { body, versionId, updatedAt: sql`now()` },
        })
        .returning();
      await recordEvent(tx, tenant.shopId, { type: input.type, removed: false });
      return { ok: true, value: toRecord(row!) };
    });
  }

  /** The versions `ids` name, by ID, whatever the policies have become since (ADR-057). */
  async versions(
    tenant: TenantContext,
    ids: readonly string[],
  ): Promise<Map<string, PolicyVersionRecord>> {
    if (ids.length === 0) return new Map();
    const rows = await this.db.tenant(tenant.shopId, (tx) =>
      tx
        .select()
        .from(policyVersions)
        .where(and(eq(policyVersions.shopId, tenant.shopId), inArray(policyVersions.id, [...ids]))),
    );
    return new Map(
      rows.map((row) => [
        row.id,
        {
          id: row.id,
          type: row.type,
          title: POLICY_TITLES[row.type].en,
          body: row.body,
          createdAt: row.createdAt,
        },
      ]),
    );
  }

  /** The storefront's address, where its policies are: at the shop's primary domain, if any. */
  async storefrontUrl(tenant: TenantContext): Promise<string> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const profile = await shopProfile(tx, tenant.shopId);
      const primary = await this.domains.primaryOf(tx, tenant.shopId);
      return primary ? this.site.urlAt(primary) : this.site.url(profile.handle);
    });
  }
}

/**
 * The shop's policies, in Shopify's order, each with its words in other languages that translate
 * it as it is (ADR-239), in the caller's transaction `tx`: for read models built outside the
 * module, such as the storefront's.
 */
export async function shopPoliciesOf(
  tx: Tx,
  shopId: string,
): Promise<{ type: PolicyType; body: string; translations: Partial<Record<string, string>> }[]> {
  const rows = await tx.select().from(policies).where(eq(policies.shopId, shopId));
  const kept =
    rows.length === 0
      ? []
      : await tx
          .select()
          .from(translations)
          .where(
            and(
              eq(translations.shopId, shopId),
              inArray(
                translations.resourceId,
                rows.map((row) => row.id),
              ),
              eq(translations.key, 'body'),
            ),
          );
  return inOrder(rows).map((row) => {
    // Its words in each language while they translate it as it is (ADR-239): a policy's words are
    // the terms its customers agree to, so one translated from words since changed is not shown.
    const digest = digestOf(row.body);
    return {
      type: row.type,
      body: row.body,
      translations: Object.fromEntries(
        kept
          .filter((each) => each.resourceId === row.id && each.digest === digest)
          .map((each) => [each.locale, each.value]),
      ),
    };
  });
}

/** A policy the shop has, by its kind and the version its body is now. */
export interface PolicyVersionRef {
  type: PolicyType;
  versionId: string;
}

/**
 * The policies the shop has, in Shopify's order, by kind and current version, without their
 * bodies, in the caller's transaction `tx`: for pages that link them and orders that keep what
 * their customers agreed to, such as the checkout's (ADR-057).
 */
export async function shopPolicyVersionsOf(tx: Tx, shopId: string): Promise<PolicyVersionRef[]> {
  const rows = await tx
    .select({ type: policies.type, versionId: policies.versionId })
    .from(policies)
    .where(eq(policies.shopId, shopId));
  return rows.sort((a, b) => POLICY_TYPES.indexOf(a.type) - POLICY_TYPES.indexOf(b.type));
}

/** Nothing to read: no text, and no image. */
function isBlank(html: string): boolean {
  return (
    !/<img\b/i.test(html) &&
    html
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/g, ' ')
      .trim() === ''
  );
}

function inOrder(rows: PolicyRow[]): PolicyRow[] {
  return [...rows].sort((a, b) => POLICY_TYPES.indexOf(a.type) - POLICY_TYPES.indexOf(b.type));
}

async function recordEvent(tx: Tx, shopId: string, payload: PolicyUpdatedPayload): Promise<void> {
  await appendEvent<PolicyUpdatedPayload>(tx, shopId, {
    type: OnlineStoreEvents.PolicyUpdated,
    aggregateType: 'shop_policy',
    aggregateId: shopId,
    payload,
  });
}

function toRecord(row: PolicyRow): PolicyRecord {
  return {
    id: row.id,
    type: row.type,
    title: POLICY_TITLES[row.type].en,
    body: row.body,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
