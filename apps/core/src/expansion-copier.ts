import {
  ROLE_SCOPES,
  failOne,
  shopProfile,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import {
  ExpansionStoreService,
  ProductExportService,
  ProductImportService,
  rescaledShopifyPrices,
  type ExpansionCopyResult,
  type ExpansionStoreRecord,
} from '@hatti/catalog/public';
import { Database } from '@hatti/db';
import { newId } from '@hatti/ids';
import type { Logger } from '@hatti/logger';
import { isCurrencyCode } from '@hatti/money';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

type StaffActor = Extract<TenantContext['actor'], { kind: 'staff' }>;

/**
 * Copies a shop's products to an expansion store of its (CH-11, ADR-859), as its owner, who must
 * own both: through the product export of this shop and the import of the other, at the link's
 * rate, the import updating by handle what the other has already. Asked for in the admin, or as
 * products change (ADR-913).
 */
@Injectable()
export class ExpansionCopier {
  constructor(
    private readonly db: Database,
    private readonly stores: ExpansionStoreService,
    private readonly exports: ProductExportService,
    private readonly imports: ProductImportService,
  ) {}

  /**
   * The owner of `shopId`, as the shop's staff list has them for the app's login, the worker's
   * too; null for a shop closed, or with none.
   */
  async ownerOf(shopId: string): Promise<string | null> {
    const { rows } = await this.db.tenant(shopId, (tx) =>
      tx.execute<{ user_id: string }>(sql`
        SELECT user_id FROM identity.staff_phones(${shopId}) WHERE role = 'owner' LIMIT 1`),
    );
    return rows[0]?.user_id ?? null;
  }

  /** Whether `userId` is the owner of `shopId`. */
  async owns(userId: string, shopId: string): Promise<boolean> {
    return (await this.ownerOf(shopId)) === userId;
  }

  /** Copies the shop's products to `targetShopId`, as the owner `actor`, the copy begun `at`. */
  async copy(
    tenant: TenantContext,
    actor: StaffActor,
    targetShopId: string,
    at: Date = new Date(),
  ): Promise<MutationResult<ExpansionStoreRecord>> {
    const link = await this.stores.get(tenant, targetShopId);
    if (!link || !(await this.owns(actor.userId, targetShopId))) {
      return failOne(['shopId'], 'NOT_FOUND', 'No such expansion store');
    }
    const exported = await this.exports.export(tenant, '', null);
    if (!exported.ok) return exported;
    const currency = (await this.db.tenant(targetShopId, (tx) => shopProfile(tx, targetShopId)))
      .currency;
    if (!isCurrencyCode(currency)) {
      return failOne(['shopId'], 'INVALID', 'The expansion store has no currency Hatti knows');
    }
    // The owner, acting in the other shop as its owner.
    const there: TenantContext = {
      shopId: targetShopId,
      currency,
      scopes: new Set(ROLE_SCOPES.owner),
      actor: { ...actor, role: 'owner', customRoleId: null },
    };
    const imported = await this.imports.import(
      there,
      // Its margin over its rate, its collections' own (ADR-948), and its prices rounded as it
      // asks (ADR-933).
      rescaledShopifyPrices(exported.value.csv, Number(link.priceRate), {
        rounding: link.rounding,
        marginPercent: link.marginPercent,
        marginOf: await this.stores.marginsByHandle(tenant, link.collectionMargins),
      }),
      { overwrite: true },
    );
    if (!imported.ok) return imported;
    const result: ExpansionCopyResult = {
      created: imported.value.created,
      updated: imported.value.updated,
      problems: imported.value.rowErrorCount,
    };
    const saved = await this.stores.copied(tenant, targetShopId, result, at);
    return saved
      ? { ok: true, value: saved }
      : failOne(['shopId'], 'NOT_FOUND', 'No such expansion store');
  }

  /**
   * One sweep of the links copying as products change (ADR-913): each due one copied as the
   * source shop's owner, who must still own the expansion store. What fails is kept with why, for
   * the owner to see, and tried again an hour on. How many were copied.
   */
  async sweep(at: Date = new Date(), logger?: Logger): Promise<number> {
    let copied = 0;
    for (const { shopId, targetShopId } of await this.stores.dueForCopy(at)) {
      try {
        const owner = await this.ownerOf(shopId);
        const currency = (await this.db.tenant(shopId, (tx) => shopProfile(tx, shopId))).currency;
        if (!owner || !isCurrencyCode(currency)) {
          await this.stores.failed(shopId, targetShopId, "The shop's owner wasn't found", at);
          continue;
        }
        const actor: StaffActor = {
          kind: 'staff',
          userId: owner,
          sessionId: newId(),
          role: 'owner',
          authenticatedAt: at,
        };
        const tenant: TenantContext = {
          shopId,
          currency,
          scopes: new Set(ROLE_SCOPES.owner),
          actor,
        };
        const result = await this.copy(tenant, actor, targetShopId, at);
        if (result.ok) copied += 1;
        else {
          const why =
            result.errors[0]?.code === 'NOT_FOUND'
              ? 'The same person no longer owns both shops'
              : (result.errors[0]?.message ?? 'The copy failed');
          await this.stores.failed(shopId, targetShopId, why, at);
        }
      } catch (error) {
        logger?.warn({ err: error, shopId, targetShopId }, 'expansion store not copied');
        await this.stores.failed(shopId, targetShopId, 'The copy failed; it is tried again', at);
      }
    }
    return copied;
  }
}
