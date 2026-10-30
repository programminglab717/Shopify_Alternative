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
import {
  EXPANSION_GROUP_KINDS,
  ExpansionStoreService,
  type ExpansionGroupKind,
  type ExpansionStoreRecord,
} from '@hatti/catalog/public';
import { Database } from '@hatti/db';
import { toPublicId, tryFromPublicId } from '@hatti/ids';
import { isCurrencyCode, money } from '@hatti/money';
import {
  SalesInterval,
  SalesReportService,
  netSales,
  tallyOf,
  totalSales,
  type SalesIntervalValue,
} from '@hatti/orders/public';
import { ExpansionCopier } from '../expansion-copier.js';
import { convertBetween, dayRateBetween, rupeeRatesIn } from '../expansion-rates.js';
import {
  Args,
  Field,
  GraphQLISODateTime,
  ID,
  InputType,
  Int,
  Mutation,
  ObjectType,
  Query,
  Resolver,
} from '@nestjs/graphql';
import { sql } from 'drizzle-orm';

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
    "A collection of this shop's whose products are put a margin of their own over an " +
    "expansion store's rate (ADR-948).",
})
export class ExpansionCollectionMargin {
  @Field(() => ID)
  collectionId!: string;

  @Field()
  collectionTitle!: string;

  @Field(() => Int)
  marginPercent!: number;
}

@ObjectType({
  description:
    "A product of this shop's put a margin of its own over an expansion store's rate, before its " +
    "collections' (ADR-960).",
})
export class ExpansionProductMargin {
  @Field(() => ID)
  productId!: string;

  @Field()
  productTitle!: string;

  @Field(() => Int)
  marginPercent!: number;
}

@ObjectType({
  description:
    "A product type's or a vendor's products put a margin of their own over an expansion store's " +
    "rate, after a product's own and its collections', before the store's (ADR-971).",
})
export class ExpansionGroupMargin {
  @Field({ description: 'PRODUCT_TYPE or VENDOR.' })
  by!: string;

  @Field({ description: 'The product type or vendor, as products give it, letter case aside.' })
  value!: string;

  @Field(() => Int)
  marginPercent!: number;
}

@InputType()
export class ExpansionGroupMarginInput {
  @Field({ description: 'PRODUCT_TYPE or VENDOR.' })
  by!: string;

  @Field({ description: 'The product type or vendor.' })
  value!: string;

  @Field(() => Int, { description: 'A whole percent, 0 to 100.' })
  marginPercent!: number;
}

@InputType()
export class ExpansionProductMarginInput {
  @Field(() => ID)
  productId!: string;

  @Field(() => Int, { description: 'A whole percent, 0 to 100.' })
  marginPercent!: number;
}

@InputType()
export class ExpansionCollectionMarginInput {
  @Field(() => ID)
  collectionId!: string;

  @Field(() => Int, { description: 'A whole percent, 0 to 100.' })
  marginPercent!: number;
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

  @Field(() => [ExpansionCollectionMargin], {
    description:
      'Collections whose products are put a margin of their own over its rate, the first of a ' +
      "product's collections here giving its margin; its own margin for the rest (ADR-948). A " +
      'collection deleted since is left out.',
  })
  collectionMargins!: ExpansionCollectionMargin[];

  @Field(() => [ExpansionProductMargin], {
    description:
      "Products put a margin of their own over its rate, in place of their collections' and its " +
      'own (ADR-960). A product deleted since is left out.',
  })
  productMargins!: ExpansionProductMargin[];

  @Field(() => [ExpansionGroupMargin], {
    description:
      'Product types and vendors whose products are put a margin of their own over its rate, ' +
      "after a product's own and its collections', a type's before a vendor's (ADR-971).",
  })
  groupMargins!: ExpansionGroupMargin[];

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
    "A day, week or month of what one of the owner's shops sold (ADR-955), from its start in " +
    "this shop's time, so that each store's days are the same.",
})
export class ExpansionStoreSalesPeriod {
  @Field(() => GraphQLISODateTime, { description: "When it starts, in this shop's time zone." })
  start!: Date;

  @Field(() => Int, { description: 'Its orders, cancelled ones aside.' })
  orders!: number;

  @Field(() => Money, { description: 'Its total sales, in the store’s own currency.' })
  totalSales!: Money;

  @Field(() => Money, {
    nullable: true,
    description:
      "Its total sales in this shop's currency at the day's rate, as the store's; null where " +
      'the feed has no rate for its currency.',
  })
  totalSalesHere!: Money | null;
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

  @Field(() => [ExpansionStoreSalesPeriod], {
    description:
      "Its sales day by day, week by week or month by month, as the query's interval says, in " +
      "this shop's time zone (ADR-955): each store's periods are the same, for one chart.",
  })
  periods!: ExpansionStoreSalesPeriod[];
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
      'stores the owner still owns, oldest first, each by day, week or month in this shop’s time ' +
      '(ADR-955). 366 days at most. The owner alone.',
  })
  @RequireScopes('read_orders')
  async expansionStoreSales(
    @CurrentTenant() tenant: TenantContext,
    @Args('placedFrom', { type: () => GraphQLISODateTime }) placedFrom: Date,
    @Args('placedBefore', { type: () => GraphQLISODateTime }) placedBefore: Date,
    @Args('interval', {
      type: () => SalesInterval,
      defaultValue: SalesInterval.DAY,
      description: 'How `periods` divide the period.',
    })
    interval: SalesInterval,
  ): Promise<ExpansionStoreSales[]> {
    const actor = owner(tenant);
    const linked = await this.stores.list(tenant);
    const shops = [tenant.shopId];
    for (const record of linked) {
      if (await this.copier.owns(actor.userId, record.targetShopId))
        shops.push(record.targetShopId);
    }
    const [rates, { timezone }] = await this.db.tenant(tenant.shopId, async (tx) => [
      await rupeeRatesIn(tx),
      await shopProfile(tx, tenant.shopId),
    ]);
    const rows: ExpansionStoreSales[] = [];
    for (const shopId of shops) {
      // Each store's days are this shop's, for one chart of them all.
      const periods = await this.#sales.periodsOf(
        shopId,
        {
          placedFrom,
          placedBefore,
          interval: interval.toLowerCase() as SalesIntervalValue,
        },
        timezone,
      );
      if (!periods.ok) throw badUserInput(periods.errors[0]!.message);
      const profile = await this.db.tenant(shopId, (tx) => shopProfile(tx, shopId));
      const currency = isCurrencyCode(profile.currency) ? profile.currency : 'PKR';
      const totals = tallyOf(periods.value);
      const total = totalSales(totals);
      const hereOf = (amount: bigint) => {
        const converted = convertBetween(rates, amount, currency, tenant.currency);
        return converted === null ? null : Money.from(money(converted, tenant.currency));
      };
      rows.push(
        Object.assign(new ExpansionStoreSales(), {
          shopId: toPublicId('shop', shopId),
          name: profile.name,
          here: shopId === tenant.shopId,
          currencyCode: currency,
          orders: totals.orders,
          netSales: Money.from(money(netSales(totals), currency)),
          totalSales: Money.from(money(total, currency)),
          totalSalesHere: hereOf(total),
          periods: periods.value.map((period) =>
            Object.assign(new ExpansionStoreSalesPeriod(), {
              start: period.start,
              orders: period.orders,
              totalSales: Money.from(money(totalSales(period), currency)),
              totalSalesHere: hereOf(totalSales(period)),
            }),
          ),
        }),
      );
    }
    return rows;
  }

  @Query(() => [ExpansionStore], { description: "The shop's expansion stores, oldest first." })
  @RequireScopes('read_products')
  async expansionStores(@CurrentTenant() tenant: TenantContext): Promise<ExpansionStore[]> {
    const records = await this.stores.list(tenant);
    return Promise.all(records.map((record) => this.#shown(tenant, record)));
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
    return this.#payload(tenant, result);
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
      tenant,
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
      tenant,
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
      return this.#payload(tenant, failOne(['shopId'], 'NOT_FOUND', 'No such expansion store'));
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
    return this.#payload(tenant, await this.stores.setFollowRate(tenant, target, enabled, rate));
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
      return this.#payload(tenant, failOne(['shopId'], 'NOT_FOUND', 'No such expansion store'));
    }
    return this.#payload(
      tenant,
      await this.stores.setPricing(tenant, target, marginPercent, rounding.toLowerCase()),
    );
  }

  @Mutation(() => ExpansionStorePayload, {
    description:
      "Gives the products of each of this shop's collections listed a margin of their own over " +
      "the expansion store's rate, in the order given: a product in two takes the first's " +
      '(ADR-948). Ten at most; none leaves its own margin for every product. Copying as products ' +
      'change copies them again. The owner alone, of both shops, having signed in lately.',
  })
  @RequireScopes('write_products')
  @RequireRecentAuthentication()
  async expansionStoreCollectionMarginsSet(
    @CurrentTenant() tenant: TenantContext,
    @Args('shopId', { type: () => ID }) shopId: string,
    @Args('margins', { type: () => [ExpansionCollectionMarginInput] })
    margins: ExpansionCollectionMarginInput[],
  ): Promise<ExpansionStorePayload> {
    const actor = owner(tenant);
    const target = tryFromPublicId(shopId, 'shop');
    if (!target || !(await this.copier.owns(actor.userId, target))) {
      return this.#payload(tenant, failOne(['shopId'], 'NOT_FOUND', 'No such expansion store'));
    }
    const ids = margins.map((margin) => tryFromPublicId(margin.collectionId, 'collection'));
    const unknown = ids.findIndex((id) => !id);
    if (unknown >= 0) {
      return this.#payload(
        tenant,
        failOne(['margins', String(unknown), 'collectionId'], 'NOT_FOUND', 'No such collection'),
      );
    }
    return this.#payload(
      tenant,
      await this.stores.setCollectionMargins(
        tenant,
        target,
        margins.map((margin, at) => ({
          collectionId: ids[at]!,
          marginPercent: margin.marginPercent,
        })),
      ),
    );
  }

  @Mutation(() => ExpansionStorePayload, {
    description:
      "Gives each of this shop's products listed a margin of its own over the expansion store's " +
      "rate, in place of its collections' and the store's (ADR-960). Twenty-five at most; none " +
      'takes them away. Copying as products change copies them again. The owner alone, of both ' +
      'shops, having signed in lately.',
  })
  @RequireScopes('write_products')
  @RequireRecentAuthentication()
  async expansionStoreProductMarginsSet(
    @CurrentTenant() tenant: TenantContext,
    @Args('shopId', { type: () => ID }) shopId: string,
    @Args('margins', { type: () => [ExpansionProductMarginInput] })
    margins: ExpansionProductMarginInput[],
  ): Promise<ExpansionStorePayload> {
    const actor = owner(tenant);
    const target = tryFromPublicId(shopId, 'shop');
    if (!target || !(await this.copier.owns(actor.userId, target))) {
      return this.#payload(tenant, failOne(['shopId'], 'NOT_FOUND', 'No such expansion store'));
    }
    const ids = margins.map((margin) => tryFromPublicId(margin.productId, 'product'));
    const unknown = ids.findIndex((id) => !id);
    if (unknown >= 0) {
      return this.#payload(
        tenant,
        failOne(['margins', String(unknown), 'productId'], 'NOT_FOUND', 'No such product'),
      );
    }
    return this.#payload(
      tenant,
      await this.stores.setProductMargins(
        tenant,
        target,
        margins.map((margin, at) => ({
          productId: ids[at]!,
          marginPercent: margin.marginPercent,
        })),
      ),
    );
  }

  @Mutation(() => ExpansionStorePayload, {
    description:
      "Gives this shop's products of each product type or vendor listed a margin of their own " +
      "over the expansion store's rate (ADR-971), after a product's own and its collections', " +
      "before the store's; a product's type's before its vendor's. Twenty at most; none takes " +
      'them away. Copying as products change copies them again. The owner alone, of both shops, ' +
      'having signed in lately.',
  })
  @RequireScopes('write_products')
  @RequireRecentAuthentication()
  async expansionStoreGroupMarginsSet(
    @CurrentTenant() tenant: TenantContext,
    @Args('shopId', { type: () => ID }) shopId: string,
    @Args('margins', { type: () => [ExpansionGroupMarginInput] })
    margins: ExpansionGroupMarginInput[],
  ): Promise<ExpansionStorePayload> {
    const actor = owner(tenant);
    const target = tryFromPublicId(shopId, 'shop');
    if (!target || !(await this.copier.owns(actor.userId, target))) {
      return this.#payload(tenant, failOne(['shopId'], 'NOT_FOUND', 'No such expansion store'));
    }
    return this.#payload(
      tenant,
      await this.stores.setGroupMargins(
        tenant,
        target,
        margins.map((margin) => ({
          by: margin.by.toLowerCase() as ExpansionGroupKind,
          value: margin.value,
          marginPercent: margin.marginPercent,
        })),
      ),
    );
  }

  async #shown(tenant: TenantContext, record: ExpansionStoreRecord): Promise<ExpansionStore> {
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
      collectionMargins: await this.#margins(record, tenant.shopId),
      productMargins: await this.#productMargins(record, tenant.shopId),
      groupMargins: record.groupMargins
        .filter((margin) => EXPANSION_GROUP_KINDS.includes(margin.by))
        .map((margin) =>
          Object.assign(new ExpansionGroupMargin(), {
            by: margin.by.toUpperCase(),
            value: margin.value,
            marginPercent: margin.marginPercent,
          }),
        ),
      copyError: record.copyError,
      copyFailedAt: record.failedAt,
    });
  }

  /** Its collections' margins, as this shop's collections are titled; those deleted left out. */
  async #margins(
    record: ExpansionStoreRecord,
    shopId: string,
  ): Promise<ExpansionCollectionMargin[]> {
    if (record.collectionMargins.length === 0) return [];
    const { rows } = await this.db.tenant(shopId, (tx) =>
      tx.execute<{ id: string; title: string }>(sql`
        SELECT id, title FROM catalog.collections
         WHERE shop_id = ${shopId}
           AND id = ANY(${sql.param(record.collectionMargins.map((each) => each.collectionId))}::uuid[])`),
    );
    const titles = new Map(rows.map((row) => [row.id, row.title]));
    return record.collectionMargins.flatMap((margin) => {
      const title = titles.get(margin.collectionId);
      return title === undefined
        ? []
        : [
            Object.assign(new ExpansionCollectionMargin(), {
              collectionId: toPublicId('collection', margin.collectionId),
              collectionTitle: title,
              marginPercent: margin.marginPercent,
            }),
          ];
    });
  }

  /** Its products' own margins, as this shop's products are titled; those deleted left out. */
  async #productMargins(
    record: ExpansionStoreRecord,
    shopId: string,
  ): Promise<ExpansionProductMargin[]> {
    if (record.productMargins.length === 0) return [];
    const { rows } = await this.db.tenant(shopId, (tx) =>
      tx.execute<{ id: string; title: string }>(sql`
        SELECT id, title FROM catalog.products
         WHERE shop_id = ${shopId}
           AND id = ANY(${sql.param(record.productMargins.map((each) => each.productId))}::uuid[])`),
    );
    const titles = new Map(rows.map((row) => [row.id, row.title]));
    return record.productMargins.flatMap((margin) => {
      const title = titles.get(margin.productId);
      return title === undefined
        ? []
        : [
            Object.assign(new ExpansionProductMargin(), {
              productId: toPublicId('product', margin.productId),
              productTitle: title,
              marginPercent: margin.marginPercent,
            }),
          ];
    });
  }

  async #payload(
    tenant: TenantContext,
    result: MutationResult<ExpansionStoreRecord>,
  ): Promise<ExpansionStorePayload> {
    return Object.assign(new ExpansionStorePayload(), {
      expansionStore: result.ok ? await this.#shown(tenant, result.value) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }
}
