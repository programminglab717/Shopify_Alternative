import {
  CurrentTenant,
  ROLE_SCOPES,
  RequireRecentAuthentication,
  RequireScopes,
  UserError,
  deniedToRole,
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
import { StaffService } from '@hatti/identity/public';
import { toPublicId, tryFromPublicId } from '@hatti/ids';
import { isCurrencyCode } from '@hatti/money';
import {
  Args,
  Field,
  GraphQLISODateTime,
  ID,
  Int,
  Mutation,
  ObjectType,
  Query,
  Resolver,
} from '@nestjs/graphql';

@ObjectType()
export class ExpansionCopy {
  @Field(() => Int)
  created!: number;

  @Field(() => Int)
  updated!: number;

  @Field(() => Int, { description: 'Rows the expansion store could not take.' })
  problems!: number;
}

@ObjectType({
  description:
    "Another shop of the owner's whose products are copied from this one, priced at a rate " +
    "(CH-11, ADR-859), as Shopify Plus's expansion stores.",
})
export class ExpansionStore {
  @Field(() => ID)
  shopId!: string;

  @Field()
  name!: string;

  @Field({ description: "Its currency, as its prices are: 'USD'." })
  currencyCode!: string;

  @Field({ description: 'What a price here is multiplied by there: "0.0036".' })
  priceRate!: string;

  @Field(() => GraphQLISODateTime, { nullable: true })
  copiedAt!: Date | null;

  @Field(() => ExpansionCopy, { nullable: true })
  lastCopy!: ExpansionCopy | null;
}

@ObjectType()
export class ExpansionStorePayload {
  @Field(() => ExpansionStore, { nullable: true })
  expansionStore!: ExpansionStore | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

/** The owner alone links shops and copies between them, being the owner of both. */
function owner(tenant: TenantContext): Extract<TenantContext['actor'], { kind: 'staff' }> {
  if (tenant.actor.kind !== 'staff' || tenant.actor.role !== 'owner') {
    throw deniedToRole("Access denied. Only the shop's owner keeps its expansion stores.");
  }
  return tenant.actor;
}

/**
 * Expansion stores (ADR-859): the catalog keeps which of the owner's shops are copied to and at
 * what rate; the core checks the owner holds both, and copies through the product export of this
 * shop and the import of the other, the import updating what the other has already.
 */
@Resolver(() => ExpansionStore)
export class ExpansionStoreResolver {
  constructor(
    private readonly db: Database,
    private readonly stores: ExpansionStoreService,
    private readonly staff: StaffService,
    private readonly exports: ProductExportService,
    private readonly imports: ProductImportService,
  ) {}

  @Query(() => [ExpansionStore], { description: "The shop's expansion stores, oldest first." })
  @RequireScopes('read_products')
  async expansionStores(@CurrentTenant() tenant: TenantContext): Promise<ExpansionStore[]> {
    const records = await this.stores.list(tenant);
    return Promise.all(records.map((record) => this.#shown(record)));
  }

  @Mutation(() => ExpansionStorePayload, {
    description:
      "Makes another shop of the owner's an expansion store of this one, or changes its rate. " +
      'The owner alone, of both shops, having signed in lately.',
  })
  @RequireScopes('write_products')
  @RequireRecentAuthentication()
  async expansionStoreSave(
    @CurrentTenant() tenant: TenantContext,
    @Args('shopId', { type: () => ID }) shopId: string,
    @Args('priceRate') priceRate: string,
  ): Promise<ExpansionStorePayload> {
    const actor = owner(tenant);
    const target = tryFromPublicId(shopId, 'shop');
    const result: MutationResult<ExpansionStoreRecord> =
      target && (await this.#owns(actor.userId, target))
        ? await this.stores.save(tenant, target, priceRate)
        : failOne(['shopId'], 'NOT_FOUND', 'You own no other shop of that ID');
    return this.#payload(result);
  }

  @Mutation(() => ExpansionStorePayload, {
    description: "Ends an expansion store's link; it keeps what was copied. The owner alone.",
  })
  @RequireScopes('write_products')
  async expansionStoreRemove(
    @CurrentTenant() tenant: TenantContext,
    @Args('shopId', { type: () => ID }) shopId: string,
  ): Promise<ExpansionStorePayload> {
    owner(tenant);
    const target = tryFromPublicId(shopId, 'shop');
    const removed = target ? await this.stores.remove(tenant, target) : false;
    return Object.assign(new ExpansionStorePayload(), {
      expansionStore: null,
      userErrors: removed
        ? []
        : UserError.list([
            { field: ['shopId'], code: 'NOT_FOUND', message: 'No such expansion store' },
          ]),
    });
  }

  @Mutation(() => ExpansionStorePayload, {
    description:
      "Copies the shop's products to an expansion store, at its rate: those it has already, by " +
      'handle, updated, and new ones added as drafts or as they are here. The owner alone, of ' +
      'both shops, having signed in lately.',
  })
  @RequireScopes('write_products')
  @RequireRecentAuthentication()
  async expansionStoreCopy(
    @CurrentTenant() tenant: TenantContext,
    @Args('shopId', { type: () => ID }) shopId: string,
  ): Promise<ExpansionStorePayload> {
    const actor = owner(tenant);
    const target = tryFromPublicId(shopId, 'shop');
    const link = target ? await this.stores.get(tenant, target) : null;
    if (!target || !link || !(await this.#owns(actor.userId, target))) {
      return this.#payload(failOne(['shopId'], 'NOT_FOUND', 'No such expansion store'));
    }
    const exported = await this.exports.export(tenant, '', null);
    if (!exported.ok) return this.#payload(exported);
    const currency = (await this.db.tenant(target, (tx) => shopProfile(tx, target))).currency;
    if (!isCurrencyCode(currency)) {
      return this.#payload(
        failOne(['shopId'], 'INVALID', 'The expansion store has no currency Hatti knows'),
      );
    }
    // The owner, acting in the other shop as its owner.
    const there: TenantContext = {
      shopId: target,
      currency,
      scopes: new Set(ROLE_SCOPES.owner),
      actor: { ...actor, role: 'owner', customRoleId: null },
    };
    const imported = await this.imports.import(
      there,
      rescaledShopifyPrices(exported.value.csv, Number(link.priceRate)),
      { overwrite: true },
    );
    if (!imported.ok) return this.#payload(imported);
    const result: ExpansionCopyResult = {
      created: imported.value.created,
      updated: imported.value.updated,
      problems: imported.value.rowErrorCount,
    };
    const saved = await this.stores.copied(tenant, target, result);
    return this.#payload(
      saved
        ? { ok: true, value: saved }
        : failOne(['shopId'], 'NOT_FOUND', 'No such expansion store'),
    );
  }

  /** Whether `userId` is the owner of `shopId`. */
  async #owns(userId: string, shopId: string): Promise<boolean> {
    const members = await this.staff.staffOf(shopId);
    return members.some((member) => member.userId === userId && member.role === 'owner');
  }

  async #shown(record: ExpansionStoreRecord): Promise<ExpansionStore> {
    const profile = await this.db.tenant(record.targetShopId, (tx) =>
      shopProfile(tx, record.targetShopId),
    );
    return Object.assign(new ExpansionStore(), {
      shopId: toPublicId('shop', record.targetShopId),
      name: profile.name,
      currencyCode: profile.currency,
      priceRate: record.priceRate,
      copiedAt: record.syncedAt,
      lastCopy: record.lastResult && Object.assign(new ExpansionCopy(), record.lastResult),
    });
  }

  async #payload(result: MutationResult<ExpansionStoreRecord>): Promise<ExpansionStorePayload> {
    return Object.assign(new ExpansionStorePayload(), {
      expansionStore: result.ok ? await this.#shown(result.value) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }
}
