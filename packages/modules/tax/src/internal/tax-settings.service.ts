import {
  InputChecker,
  actorColumnsOf,
  fail,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import { Database, type Tx } from '@hatti/db';
import { appendEvent, recordAudit } from '@hatti/events';
import { Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { TaxEvents, type TaxSettingsUpdatedPayload } from './events.js';
import { taxSettings } from './schema.js';
import {
  NO_TAX,
  checkNtn,
  checkStrn,
  checkTaxCategories,
  checkTaxRate,
  type TaxCategoryInput,
  type TaxSettingsRecord,
} from './tax.js';

/** Those not given stay as they are. */
export interface TaxSettingsInput {
  /** Percent included in the shop's prices, 18 for 18%; null charges none. */
  rate?: number | null;
  /** Whether delivery charges, and the fee for paying on delivery, include it too. */
  taxDelivery?: boolean | null;
  /** Replaces every category (ADR-097); an empty list for none, null leaves them. */
  categories?: TaxCategoryInput[] | null;
  /** The NTN FBR registered the shop under (ADR-190); null or blank for none. */
  ntn?: string | null;
  /** Its sales tax registration number; null or blank for none. */
  strn?: string | null;
}

/**
 * The sales tax a shop charges (TAX-01, ADR-096): a rate included in the prices of what it sells,
 * as Pakistan's consumer laws ask prices to be shown, and in its delivery charges if it says so.
 * Orders placed from then on keep the tax in them; a shop that set nothing charges none.
 */
@Injectable()
export class TaxSettingsService {
  constructor(private readonly db: Database) {}

  get(tenant: TenantContext): Promise<TaxSettingsRecord> {
    return this.db.tenant(tenant.shopId, (tx) => taxSettingsIn(tx, tenant.shopId));
  }

  /**
   * Changes those given, for orders placed from now on; records `tax_settings.updated`, and who
   * changed what in the audit log, if anything changed.
   */
  async update(
    tenant: TenantContext,
    input: TaxSettingsInput,
  ): Promise<MutationResult<TaxSettingsRecord>> {
    const check = new InputChecker();
    const rate =
      input.rate === undefined || input.rate === null
        ? input.rate
        : checkTaxRate(check, ['input', 'rate'], input.rate);
    const categories =
      input.categories === undefined || input.categories === null
        ? undefined
        : checkTaxCategories(check, ['input', 'categories'], input.categories);
    // Blank clears, as null does.
    const ntn =
      input.ntn === undefined
        ? undefined
        : input.ntn?.trim()
          ? checkNtn(check, ['input', 'ntn'], input.ntn)
          : null;
    const strn =
      input.strn === undefined
        ? undefined
        : input.strn?.trim()
          ? checkStrn(check, ['input', 'strn'], input.strn)
          : null;
    if (!check.ok) return fail(check.errors);

    return this.db.tenant(tenant.shopId, async (tx) => {
      const before = await taxSettingsIn(tx, tenant.shopId, { lock: true });
      const next = {
        rate: rate === undefined ? before.rate : rate,
        taxDelivery: input.taxDelivery ?? before.taxDelivery,
        categories: categories ?? before.categories,
        ntn: ntn === undefined ? before.ntn : ntn,
        strn: strn === undefined ? before.strn : strn,
      };
      const changed = [
        ...(next.rate !== before.rate ? ['rate'] : []),
        ...(next.taxDelivery !== before.taxDelivery ? ['taxDelivery'] : []),
        ...(JSON.stringify(next.categories) !== JSON.stringify(before.categories)
          ? ['categories']
          : []),
        ...(next.ntn !== before.ntn ? ['ntn'] : []),
        ...(next.strn !== before.strn ? ['strn'] : []),
      ];
      if (changed.length === 0) return { ok: true, value: before };
      await tx
        .insert(taxSettings)
        .values({ shopId: tenant.shopId, ...next })
        .onConflictDoUpdate({
          target: taxSettings.shopId,
          set: { ...next, updatedAt: sql`now()` },
        });
      await appendEvent<TaxSettingsUpdatedPayload>(tx, tenant.shopId, {
        type: TaxEvents.SettingsUpdated,
        aggregateType: 'tax_settings',
        aggregateId: tenant.shopId,
        payload: { changed },
      });
      await recordAudit(tx, tenant.shopId, {
        action: 'tax_settings.updated',
        subjectType: 'shop',
        subjectId: tenant.shopId,
        ...actorColumnsOf(tenant.actor),
        // As the API has them: the rate as a percentage.
        details: {
          rate: next.rate === null ? null : next.rate / 100,
          taxDelivery: next.taxDelivery,
          categories: next.categories.map((category) => ({
            ...category,
            rate: category.rate / 100,
          })),
          ntn: next.ntn,
          strn: next.strn,
        },
      });
      return { ok: true, value: await taxSettingsIn(tx, tenant.shopId) };
    });
  }
}

/**
 * The shop's sales tax, in the caller's transaction `tx`: for orders as they are placed, and for
 * checkout's page, which says what of its total is tax.
 */
export async function taxSettingsIn(
  tx: Tx,
  shopId: string,
  options: { lock?: boolean } = {},
): Promise<TaxSettingsRecord> {
  const query = tx.select().from(taxSettings).where(eq(taxSettings.shopId, shopId));
  const [row] = options.lock ? await query.for('update') : await query;
  if (!row) return NO_TAX;
  return {
    rate: row.rate,
    taxDelivery: row.taxDelivery,
    categories: row.categories,
    ntn: row.ntn,
    strn: row.strn,
    updatedAt: row.updatedAt,
  };
}
