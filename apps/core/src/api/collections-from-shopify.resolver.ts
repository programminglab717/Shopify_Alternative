import { CurrentTenant, RequireScopes, UserError, type TenantContext } from '@hatti/api';
import {
  CollectionService,
  ProductService,
  RULE_COLUMNS,
  RULE_RELATIONS,
  type CollectionRuleSetInput,
  type RuleColumn,
  type RuleRelation,
} from '@hatti/catalog/public';
import { FileService } from '@hatti/files/public';
import { readStoreCollections, type StoreCollection } from '@hatti/shopify-admin';
import { Args, Field, Int, Mutation, ObjectType, Resolver } from '@nestjs/graphql';
import { ShopifyStores, storeGiven, storeRefusalOf } from './shopify-stores.js';

/** Products put in a collection at a time, as the catalog takes them. */
const BATCH = 250;

/** Grams in each of Shopify's units of weight. */
const GRAMS: Readonly<Record<string, number>> = {
  GRAMS: 1,
  KILOGRAMS: 1_000,
  OUNCES: 28.349_523_125,
  POUNDS: 453.592_37,
};

/** Shopify's sort orders the catalog's are; best selling it has not. */
const SORT_ORDERS = new Set([
  'MANUAL',
  'ALPHA_ASC',
  'ALPHA_DESC',
  'PRICE_ASC',
  'PRICE_DESC',
  'CREATED',
  'CREATED_DESC',
]);

const PRICE_COLUMNS: readonly RuleColumn[] = ['variant_price', 'variant_compare_at_price'];

@ObjectType({
  description: "A store's collection that did not go in, or its image, and why.",
})
export class StoreCollectionImportError {
  @Field({ description: "The collection's handle at the store." })
  handle!: string;

  @Field()
  message!: string;
}

@ObjectType()
export class CollectionsImportFromShopifyPayload {
  @Field(() => Int, { description: 'Collections the store has.' })
  collections!: number;

  @Field(() => Int, { description: 'Collections made, or that would be in a dry run.' })
  created!: number;

  @Field(() => Int, {
    description: 'Collections left as they are: the shop has a collection with their handles.',
  })
  skipped!: number;

  @Field(() => Int, {
    description:
      "Products of the store's hand-picked collections the shop has no product with the handle " +
      'of, and which were left out of them; 0 in a dry run, which comes before the products do.',
  })
  productsMissing!: number;

  @Field(() => Int, {
    description: "Collections' images brought, as the shop's files (ADR-785); none in a dry run.",
  })
  images!: number;

  @Field(() => [StoreCollectionImportError])
  collectionErrors!: StoreCollectionImportError[];

  @Field()
  dryRun!: boolean;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

/**
 * A Shopify store's collections through its Admin API (ONB-05, ADR-754): each made as
 * `collectionCreate` makes one at its handle, a smart one with its rules and a hand-picked one
 * with the shop's products of the same handles, in the store's order.
 */
@Resolver()
export class CollectionsFromShopifyResolver {
  constructor(
    private readonly collections: CollectionService,
    private readonly products: ProductService,
    private readonly files: FileService,
    private readonly shopify: ShopifyStores,
  ) {}

  @Mutation(() => CollectionsImportFromShopifyPayload, {
    description:
      "Imports a Shopify store's collections through its Admin API (ONB-05, ADR-754), each " +
      'keeping its handle and so its address at /collections/{handle}: its title, description, ' +
      'search listing and sort order; a smart collection its rules, a weight in grams and a ' +
      "price in the shop's currency; a hand-picked one the shop's products with the handles of " +
      'its products, in its order, so its products come first. Collections whose handles the ' +
      'shop has are left as they are; one with a rule the catalog has not is named with why. ' +
      "A collection's image is fetched from Shopify and kept as one of the shop's files " +
      '(ADR-785); one that cannot be is said, the collection made without it. ' +
      'Give the store and its app as productsImportFromShopify takes them. Nothing given is ' +
      'kept. dryRun reads the store and counts, changing nothing.',
  })
  @RequireScopes('write_products')
  async collectionsImportFromShopify(
    @CurrentTenant() tenant: TenantContext,
    @Args('store', {
      description:
        "The store's address at Shopify, as zari.myshopify.com, its name, or a link to its admin.",
    })
    store: string,
    @Args('accessToken', { nullable: true }) accessToken?: string,
    @Args('clientId', { nullable: true }) clientId?: string,
    @Args('clientSecret', { nullable: true }) clientSecret?: string,
    @Args('dryRun', { nullable: true }) dryRun?: boolean,
  ): Promise<CollectionsImportFromShopifyPayload> {
    const dry = dryRun ?? false;
    const payload = (values: Partial<CollectionsImportFromShopifyPayload>) =>
      Object.assign(new CollectionsImportFromShopifyPayload(), {
        collections: 0,
        created: 0,
        skipped: 0,
        productsMissing: 0,
        images: 0,
        collectionErrors: [],
        dryRun: dry,
        userErrors: [],
        ...values,
      });
    const refused = (refusal: { field: string[] | null; code: string; message: string }) =>
      payload({ userErrors: [UserError.of(refusal.field, refusal.code, refusal.message)] });

    const given = storeGiven(store, accessToken, clientId, clientSecret);
    if (!given.ok) return refused(given);
    const read = await readStoreCollections(
      this.shopify.connect(given.shop, given.credentials),
      this.shopify.bulk,
    );
    if (!read.ok) return refused(storeRefusalOf(read));
    const { storeName, currency, weightUnit } = read.value;
    const storeCollections = read.value.collections;
    if (storeCollections.length === 0) {
      return refused({
        field: ['store'],
        code: 'BLANK',
        message: `${storeName} has no collections`,
      });
    }

    let created = 0;
    let skipped = 0;
    let productsMissing = 0;
    let images = 0;
    const collectionErrors: StoreCollectionImportError[] = [];
    const failed = (handle: string, message: string) =>
      collectionErrors.push(Object.assign(new StoreCollectionImportError(), { handle, message }));
    for (const collection of storeCollections) {
      if (await this.collections.getByHandle(tenant, collection.handle)) {
        skipped++;
        continue;
      }
      const rules = ruleSetOf(collection, {
        weightUnit,
        samePrices: currency === tenant.currency,
        currency,
      });
      if (!rules.ok) {
        failed(collection.handle, rules.message);
        continue;
      }
      if (dry) {
        created++;
        continue;
      }
      let productIds: string[] = [];
      if (!rules.ruleSet) {
        const ids = await this.products.idsByHandle(tenant, collection.products);
        productIds = [...new Set(collection.products)].flatMap((handle) => ids.get(handle) ?? []);
        productsMissing += new Set(collection.products).size - productIds.length;
      }
      const image = await this.shopify.keepImage(
        this.files,
        tenant,
        collection.image,
        collection.handle,
      );
      if (typeof image === 'string') {
        failed(collection.handle, `Its image was not brought: ${image}`);
      }
      const kept = typeof image === 'object' && image !== null ? image.fileId : null;
      const made = await this.collections.create(tenant, {
        title: collection.title,
        handle: collection.handle,
        description: collection.descriptionHtml,
        sortOrder: sortOrderOf(collection.sortOrder, rules.ruleSet !== null),
        seo: collection.seo,
        ruleSet: rules.ruleSet,
        productIds: productIds.slice(0, BATCH),
        ...(typeof image === 'object' && { image }),
      });
      if (!made.ok) {
        // The image goes with the collection that did not.
        if (kept) await this.files.delete(tenant, [kept]);
        if (made.errors.some((error) => error.code === 'TAKEN')) skipped++;
        else failed(collection.handle, made.errors.map((error) => error.message).join('; '));
        continue;
      }
      for (let at = BATCH; at < productIds.length; at += BATCH) {
        await this.collections.addProducts(tenant, made.value.id, productIds.slice(at, at + BATCH));
      }
      created++;
      if (kept) images++;
    }
    return payload({
      collections: storeCollections.length,
      created,
      skipped,
      productsMissing,
      images,
      collectionErrors,
    });
  }
}

/**
 * A smart collection's rules as the catalog's: columns and relations lower case, a weight in grams
 * where the store gave it in its own unit, and prices kept only where the shop prices in the
 * store's currency. Null for a hand-picked collection.
 */
function ruleSetOf(
  collection: StoreCollection,
  store: { weightUnit: string; samePrices: boolean; currency: string },
): { ok: true; ruleSet: CollectionRuleSetInput | null } | { ok: false; message: string } {
  if (!collection.ruleSet) return { ok: true, ruleSet: null };
  const rules: CollectionRuleSetInput['rules'] = [];
  for (const rule of collection.ruleSet.rules) {
    const column = rule.column.toLowerCase() as RuleColumn;
    const relation = rule.relation.toLowerCase() as RuleRelation;
    if (!(RULE_COLUMNS as readonly string[]).includes(column)) {
      return { ok: false, message: `Hatti's smart collections have no rule on ${rule.column}` };
    }
    if (!(RULE_RELATIONS as readonly string[]).includes(relation)) {
      return { ok: false, message: `Hatti's smart collections have no ${rule.relation} rule` };
    }
    if (PRICE_COLUMNS.includes(column) && rule.condition !== '' && !store.samePrices) {
      return { ok: false, message: `Its rules name prices in ${store.currency}` };
    }
    let condition = rule.condition;
    if (column === 'variant_weight' && condition !== '') {
      const grams = Number(condition) * (GRAMS[store.weightUnit] ?? Number.NaN);
      if (!Number.isFinite(grams) || grams < 0) {
        return { ok: false, message: `Its weight rule's ${condition} is not a weight` };
      }
      condition = String(Math.round(grams));
    }
    rules.push({ column, relation, condition });
  }
  return {
    ok: true,
    ruleSet: { appliedDisjunctively: collection.ruleSet.appliedDisjunctively, rules },
  };
}

/**
 * The catalog's sort order for Shopify's: the same where it has it; else, as for best selling,
 * the store's own order for a hand-picked collection, newest first for a smart one, which the
 * catalog sorts only by what it knows.
 */
function sortOrderOf(
  sortOrder: string,
  smart: boolean,
): 'manual' | 'alpha_asc' | 'alpha_desc' | 'price_asc' | 'price_desc' | 'created' | 'created_desc' {
  const known = SORT_ORDERS.has(sortOrder) && !(smart && sortOrder === 'MANUAL');
  if (known) return sortOrder.toLowerCase() as ReturnType<typeof sortOrderOf>;
  return smart ? 'created_desc' : 'manual';
}
