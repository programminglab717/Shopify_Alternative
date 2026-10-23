import { CurrentTenant, RequireScopes, UserError, type TenantContext } from '@hatti/api';
import {
  CollectionService,
  METAFIELD_LIMITS,
  MetafieldService,
  ProductService,
  RESERVED_NAMESPACES,
  isMetafieldType,
  type MetafieldSetInput,
} from '@hatti/catalog/public';
import { Database } from '@hatti/db';
import {
  readStoreMetafields,
  type StoreMetafieldOwner,
  type StoreOwnerMetafields,
} from '@hatti/shopify-admin';
import { Args, Field, Int, Mutation, ObjectType, Resolver } from '@nestjs/graphql';
import { ShopifyStores, storeGiven, storeRefusalOf } from './shopify-stores.js';

/** The most problems a payload names. */
const NAMED = 50;

/** A namespace or key as Hatti takes one: Shopify's apps' own, as $app:reviews, are not. */
const NAME = /^[A-Za-z0-9_-]{2,64}$/;

@ObjectType({ description: "A store's metafield that did not go in, and why." })
export class StoreMetafieldImportError {
  @Field({
    description:
      'What it is on: a product or collection by its handle, a variant as handle / its title.',
  })
  owner!: string;

  @Field({ description: 'namespace.key' })
  metafield!: string;

  @Field()
  message!: string;
}

@ObjectType()
export class MetafieldsImportFromShopifyPayload {
  @Field(() => Int, {
    description: "Metafields on the store's products, variants and collections.",
  })
  metafields!: number;

  @Field(() => Int, { description: 'Metafields set, or that would be in a dry run.' })
  set!: number;

  @Field(() => Int, {
    description:
      "Metafields of a type Hatti has not, as a file or product reference, or of an app's own " +
      'namespace, left out.',
  })
  unsupported!: number;

  @Field(() => Int, {
    description: 'Metafields on a product, variant or collection the shop has not, left out.',
  })
  missing!: number;

  @Field(() => [StoreMetafieldImportError], { description: 'The first that could not be set.' })
  metafieldErrors!: StoreMetafieldImportError[];

  @Field()
  dryRun!: boolean;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

/** What an owner at the store is called in a payload. */
function ownerName(owner: StoreMetafieldOwner): string {
  return owner.type === 'variant' ? `${owner.handle} / ${owner.title}` : owner.handle;
}

/**
 * A Shopify store's metafields through its Admin API (ONB-05, ADR-789): its products', variants'
 * and collections', set on the shop's of the same handles, variants by their titles, as
 * metafieldsSet sets them.
 */
@Resolver()
export class MetafieldsFromShopifyResolver {
  constructor(
    private readonly db: Database,
    private readonly products: ProductService,
    private readonly collections: CollectionService,
    private readonly metafields: MetafieldService,
    private readonly shopify: ShopifyStores,
  ) {}

  @Mutation(() => MetafieldsImportFromShopifyPayload, {
    description:
      "Imports a Shopify store's metafields through its Admin API (ONB-05, ADR-789): those on " +
      "its products, variants and collections, set on the shop's with the same handles, a " +
      "variant by its product's handle and its title, as metafieldsSet sets them, so themes " +
      'read them as they did. Metafields of a type Hatti has not, as references to files or ' +
      "products, or in an app's own namespace, are counted and left out; so are those whose " +
      'product, variant or collection the shop has not, so bring products and collections ' +
      "first. Set again, a metafield takes the store's value. Give the store and its app as " +
      'productsImportFromShopify takes them. Nothing given is kept. dryRun reads the store and ' +
      'counts, changing nothing.',
  })
  @RequireScopes('write_products')
  async metafieldsImportFromShopify(
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
  ): Promise<MetafieldsImportFromShopifyPayload> {
    const dry = dryRun ?? false;
    const payload = (values: Partial<MetafieldsImportFromShopifyPayload>) =>
      Object.assign(new MetafieldsImportFromShopifyPayload(), {
        metafields: 0,
        set: 0,
        unsupported: 0,
        missing: 0,
        metafieldErrors: [],
        dryRun: dry,
        userErrors: [],
        ...values,
      });
    const refused = (refusal: { field: string[] | null; code: string; message: string }) =>
      payload({ userErrors: [UserError.of(refusal.field, refusal.code, refusal.message)] });

    const given = storeGiven(store, accessToken, clientId, clientSecret);
    if (!given.ok) return refused(given);
    const read = await readStoreMetafields(
      this.shopify.connect(given.shop, given.credentials),
      this.shopify.bulk,
    );
    if (!read.ok) return refused(storeRefusalOf(read));
    const { storeName, owners } = read.value;
    if (owners.length === 0) {
      return refused({
        field: ['store'],
        code: 'BLANK',
        message: `${storeName}'s products, variants and collections have no metafields`,
      });
    }

    const counts = { set: 0, unsupported: 0, missing: 0 };
    const metafieldErrors: StoreMetafieldImportError[] = [];
    const failed = (owner: StoreMetafieldOwner, metafield: string, message: string) => {
      if (metafieldErrors.length < NAMED) {
        metafieldErrors.push(
          Object.assign(new StoreMetafieldImportError(), {
            owner: ownerName(owner),
            metafield,
            message,
          }),
        );
      }
    };
    const ids = await this.#ownerIds(tenant, owners);
    for (const { owner, metafields } of owners) {
      const kept = metafields.filter(
        (each) =>
          isMetafieldType(each.type) &&
          NAME.test(each.namespace) &&
          NAME.test(each.key) &&
          !RESERVED_NAMESPACES.has(each.namespace),
      );
      counts.unsupported += metafields.length - kept.length;
      const id = ids.get(ownerKey(owner));
      if (!id) {
        counts.missing += kept.length;
        continue;
      }
      if (dry) {
        counts.set += kept.length;
        continue;
      }
      const inputs: MetafieldSetInput[] = kept.map((each) => ({
        owner: { type: owner.type, id },
        namespace: each.namespace,
        key: each.key,
        type: each.type,
        value: each.value,
      }));
      for (let at = 0; at < inputs.length; at += METAFIELD_LIMITS.perCall) {
        const batch = inputs.slice(at, at + METAFIELD_LIMITS.perCall);
        const result = await this.metafields.set(tenant, batch);
        if (result.ok) {
          counts.set += batch.length;
          continue;
        }
        // All or none: each again alone, to set the rest and name those that will not go.
        for (const input of batch) {
          const alone = await this.metafields.set(tenant, [input]);
          if (alone.ok) counts.set++;
          else {
            failed(
              owner,
              `${input.namespace}.${input.key}`,
              alone.errors.map((error) => error.message).join('; '),
            );
          }
        }
      }
    }
    return payload({
      metafields: owners.reduce((sum, owner) => sum + owner.metafields.length, 0),
      ...counts,
      metafieldErrors,
    });
  }

  /** The shop's products, variants and collections the store's owners name, by their keys. */
  async #ownerIds(
    tenant: TenantContext,
    owners: readonly StoreOwnerMetafields[],
  ): Promise<Map<string, string>> {
    const ids = new Map<string, string>();
    const handles = [
      ...new Set(
        owners.filter(({ owner }) => owner.type !== 'collection').map(({ owner }) => owner.handle),
      ),
    ];
    const productIds = await this.products.idsByHandle(tenant, handles);
    for (const [handle, id] of productIds) ids.set(ownerKey({ type: 'product', handle }), id);
    const records = await this.db.tenant(tenant.shopId, (tx) =>
      this.products.recordsOf(tx, tenant.shopId, [...productIds.values()]),
    );
    for (const record of records) {
      for (const variant of record.variants) {
        ids.set(
          ownerKey({ type: 'variant', handle: record.handle, title: variant.title }),
          variant.id,
        );
      }
    }
    for (const { owner } of owners) {
      if (owner.type !== 'collection' || ids.has(ownerKey(owner))) continue;
      const collection = await this.collections.getByHandle(tenant, owner.handle);
      if (collection) ids.set(ownerKey(owner), collection.id);
    }
    return ids;
  }
}

/** An owner's key: its kind, its handle and, for a variant, its title in any case. */
function ownerKey(owner: StoreMetafieldOwner): string {
  return owner.type === 'variant'
    ? `variant:${owner.handle}:${owner.title.trim().toLowerCase()}`
    : `${owner.type}:${owner.handle}`;
}
