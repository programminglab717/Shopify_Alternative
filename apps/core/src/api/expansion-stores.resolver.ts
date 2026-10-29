import {
  CurrentTenant,
  Money,
  RequireRecentAuthentication,
  RequireScopes,
  UserError,
  badUserInput,
  deniedToRole,
  failOne,
  shopProfile,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import { ExpansionStoreService, type ExpansionStoreRecord } from '@hatti/catalog/public';
import { Database } from '@hatti/db';
import { toPublicId, tryFromPublicId } from '@hatti/ids';
import { isCurrencyCode, money } from '@hatti/money';
import { SalesReportService, netSales, totalSales } from '@hatti/orders/public';
import { ExpansionCopier } from '../expansion-copier.js';
import { convertBetween, dayRateBetween, rupeeRatesIn } from '../expansion-rates.js';
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

  @Field({ description: 'Whether products are copied as they change, within the hour (ADR-913).' })
  autoCopy!: boolean;

  @Field({
    description:
      "Whether its rate follows the day's rate between the shops' currencies, as the currency " +
      'feed gives it, rather than one given by hand (ADR-929).',
  })
  followRate!: boolean;

  @Field(() => Int, {
    description: 'What its copied prices are put over its rate, a whole percent (ADR-933).',
  })
  marginPercent!: number;

  @Field({
    description:
      'How its copied prices are rounded: exact, to the cent; whole, to a whole unit; or ' +
      'ninety_nine, up to .99 (ADR-933). Costs are copied exact.',
  })
  rounding!: string;

  @Field(() => String, {
    nullable: true,
    description: 'Why the last copy as products changed failed; null once one succeeds.',
  })
  copyError!: string | null;

  @Field(() => GraphQLISODateTime, { nullable: true })
  copyFailedAt!: Date | null;
}

@ObjectType({
  description:
    "What one of the owner's shops sold in a period (ADR-932): this shop, or an expansion store " +
    'of it, in its own currency and in this shop’s at the day’s rate.',
})
export class ExpansionStoreSales {
  @Field(() => ID)
  shopId!: string;

  @Field()
  name!: string;

  @Field({ description: 'Whether it is this shop, rather than an expansion store of it.' })
  here!: boolean;

  @Field()
  currencyCode!: string;

  @Field(() => Int, { description: 'Its orders placed in the period, cancelled ones aside.' })
  orders!: number;

  @Field(() => Money, { description: 'As the sales report says it, in its own currency.' })
  netSales!: Money;

  @Field(() => Money, { description: 'As the sales report says it, in its own currency.' })
  totalSales!: Money;

  @Field(() => Money, {
    nullable: true,
    description:
      "Its total sales in this shop's currency at the day's rate from the currency feed; null " +
      'where the feed has no rate for its currency.',
  })
  totalSalesHere!: Money | null;
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
  readonly #sales: SalesReportService;

  constructor(
    private readonly db: Database,
    private readonly stores: ExpansionStoreService,
    private readonly copier: ExpansionCopier,
  ) {
    this.#sales = new SalesReportService(db);
  }

  @Query(() => [ExpansionStoreSales], {
    description:
      'What this shop and each of its expansion stores sold in a period, on one page (ADR-932): ' +
      "each in its own currency and in this shop's at the day's rate, this shop first, then the " +
      'stores the owner still owns, oldest first. 366 days at most. The owner alone.',
  })
  @RequireScopes('read_orders')
  async expansionStoreSales(
    @CurrentTenant() tenant: TenantContext,
    @Args('placedFrom', { type: () => GraphQLISODateTime }) placedFrom: Date,
    @Args('placedBefore', { type: () => GraphQLISODateTime }) placedBefore: Date,
  ): Promise<ExpansionStoreSales[]> {
    const actor = owner(tenant);
    const linked = await this.stores.list(tenant);
    const shops = [tenant.shopId];
    for (const record of linked) {
      if (await this.copier.owns(actor.userId, record.targetShopId))
        shops.push(record.targetShopId);
    }
    const rates = await this.db.tenant(tenant.shopId, (tx) => rupeeRatesIn(tx));
    const rows: ExpansionStoreSales[] = [];
    for (const shopId of shops) {
      const result = await this.#sales.totalsOf(shopId, { placedFrom, placedBefore });
      if (!result.ok) throw badUserInput(result.errors[0]!.message);
      const profile = await this.db.tenant(shopId, (tx) => shopProfile(tx, shopId));
      const currency = isCurrencyCode(profile.currency) ? profile.currency : 'PKR';
      const total = totalSales(result.value);
      const here = convertBetween(rates, total, currency, tenant.currency);
      rows.push(
        Object.assign(new ExpansionStoreSales(), {
          shopId: toPublicId('shop', shopId),
          name: profile.name,
          here: shopId === tenant.shopId,
          currencyCode: currency,
          orders: result.value.orders,
          netSales: Money.from(money(netSales(result.value), currency)),
          totalSales: Money.from(money(total, currency)),
          totalSalesHere: here === null ? null : Money.from(money(here, tenant.currency)),
        }),
      );
    }
    return rows;
  }

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
      target && (await this.copier.owns(actor.userId, target))
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
    return this.#payload(
      target
        ? await this.copier.copy(tenant, actor, target)
        : failOne(['shopId'], 'NOT_FOUND', 'No such expansion store'),
    );
  }

  @Mutation(() => ExpansionStorePayload, {
    description:
      "Has the shop's products copied to an expansion store as they change, within the hour of " +
      'being left alone ten minutes, or only when asked (ADR-913). The owner alone, of both ' +
      'shops, having signed in lately.',
  })
  @RequireScopes('write_products')
  @RequireRecentAuthentication()
  async expansionStoreAutoCopySet(
    @CurrentTenant() tenant: TenantContext,
    @Args('shopId', { type: () => ID }) shopId: string,
    @Args('enabled') enabled: boolean,
  ): Promise<ExpansionStorePayload> {
    const actor = owner(tenant);
    const target = tryFromPublicId(shopId, 'shop');
    return this.#payload(
      target && (await this.copier.owns(actor.userId, target))
        ? await this.stores.setAutoCopy(tenant, target, enabled)
        : failOne(['shopId'], 'NOT_FOUND', 'No such expansion store'),
    );
  }

  @Mutation(() => ExpansionStorePayload, {
    description:
      "Has an expansion store's rate follow the day's rate between the shops' currencies, as the " +
      'currency feed gives it, products copied as they change being copied again at each new ' +
      'rate; or keeps the rate it has, fixed (ADR-929). The owner alone, of both shops, having ' +
      'signed in lately.',
  })
  @RequireScopes('write_products')
  @RequireRecentAuthentication()
  async expansionStoreFollowRateSet(
    @CurrentTenant() tenant: TenantContext,
    @Args('shopId', { type: () => ID }) shopId: string,
    @Args('enabled') enabled: boolean,
  ): Promise<ExpansionStorePayload> {
    const actor = owner(tenant);
    const target = tryFromPublicId(shopId, 'shop');
    if (!target || !(await this.copier.owns(actor.userId, target))) {
      return this.#payload(failOne(['shopId'], 'NOT_FOUND', 'No such expansion store'));
    }
    const rate = enabled
      ? await this.db.tenant(target, async (tx) =>
          dayRateBetween(
            await rupeeRatesIn(tx),
            tenant.currency,
            (await shopProfile(tx, target)).currency,
          ),
        )
      : null;
    return this.#payload(await this.stores.setFollowRate(tenant, target, enabled, rate));
  }

  @Mutation(() => ExpansionStorePayload, {
    description:
      "Puts an expansion store's copied prices a percent over its rate, 0 to 100, for what " +
      'selling abroad costs, and rounds them as its prices are: exact, whole or ninety_nine ' +
      '(ADR-933). Costs are copied at the rate alone, exact. Copying as products change copies ' +
      'them again. The owner alone, of both shops, having signed in lately.',
  })
  @RequireScopes('write_products')
  @RequireRecentAuthentication()
  async expansionStorePricingSet(
    @CurrentTenant() tenant: TenantContext,
    @Args('shopId', { type: () => ID }) shopId: string,
    @Args('marginPercent', { type: () => Int }) marginPercent: number,
    @Args('rounding') rounding: string,
  ): Promise<ExpansionStorePayload> {
    const actor = owner(tenant);
    const target = tryFromPublicId(shopId, 'shop');
    if (!target || !(await this.copier.owns(actor.userId, target))) {
      return this.#payload(failOne(['shopId'], 'NOT_FOUND', 'No such expansion store'));
    }
    return this.#payload(
      await this.stores.setPricing(tenant, target, marginPercent, rounding.toLowerCase()),
    );
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
      autoCopy: record.autoCopy,
      followRate: record.followRate,
      marginPercent: record.marginPercent,
      rounding: record.rounding,
      copyError: record.copyError,
      copyFailedAt: record.failedAt,
    });
  }

  async #payload(result: MutationResult<ExpansionStoreRecord>): Promise<ExpansionStorePayload> {
    return Object.assign(new ExpansionStorePayload(), {
      expansionStore: result.ok ? await this.#shown(result.value) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }
}
