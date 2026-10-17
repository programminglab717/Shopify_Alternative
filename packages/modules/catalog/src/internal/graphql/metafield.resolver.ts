import {
  CurrentTenant,
  Loaders,
  RequestLoaders,
  RequireScopes,
  UserError,
  failOne,
  type TenantContext,
} from '@hatti/api';
import { parsePublicId, toPublicId, tryFromPublicId, type IdKind } from '@hatti/ids';
import { Args, ID, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import {
  MetafieldService,
  type MetafieldDefinitionRecord,
  type MetafieldOwner,
  type MetafieldOwnerType,
  type MetafieldRecord,
} from '../metafields.js';
import { Collection } from './collection.types.js';
import {
  Metafield,
  MetafieldDefinition,
  MetafieldDefinitionCreatePayload,
  MetafieldDefinitionDeletePayload,
  MetafieldDefinitionInput,
  MetafieldDefinitionUpdateInput,
  MetafieldDefinitionUpdatePayload,
  MetafieldIdentifier,
  MetafieldIdentifierInput,
  MetafieldOwnerTypeValue,
  MetafieldsDeletePayload,
  MetafieldsSetInput,
  MetafieldsSetPayload,
} from './metafield.types.js';
import { Product, ProductVariant } from './product.types.js';

const KIND: Record<MetafieldOwnerType, IdKind> = {
  product: 'product',
  variant: 'variant',
  collection: 'collection',
};

/** The owner a public ID names, a product's, a variant's or a collection's; null for any other. */
function ownerOf(id: string): MetafieldOwner | null {
  try {
    const { kind, uuid } = parsePublicId(id);
    if (kind === 'product' || kind === 'variant' || kind === 'collection') {
      return { type: kind, id: uuid };
    }
    return null;
  } catch {
    return null;
  }
}

function toMetafield(record: MetafieldRecord): Metafield {
  return Object.assign(new Metafield(), {
    id: toPublicId('metafield', record.id),
    ownerId: toPublicId(KIND[record.owner.type], record.owner.id),
    ownerType: record.owner.type as MetafieldOwnerTypeValue,
    namespace: record.namespace,
    key: record.key,
    type: record.type,
    value: record.value,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

function toDefinition(record: MetafieldDefinitionRecord): MetafieldDefinition {
  return Object.assign(new MetafieldDefinition(), {
    id: toPublicId('metafieldDefinition', record.id),
    ownerType: record.ownerType as MetafieldOwnerTypeValue,
    namespace: record.namespace,
    key: record.key,
    type: record.type,
    name: record.name,
    description: record.description,
    metafieldsCount: record.valuesCount,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

const NO_OWNER = 'No product, variant or collection of the shop has this ID';
const NO_DEFINITION = 'No definition of the shop has this ID';

/** An owner's metafields, all of them or in one namespace, loaded for every owner at once. */
async function metafieldsOf(
  service: MetafieldService,
  tenant: TenantContext,
  loaders: RequestLoaders,
  owner: MetafieldOwner,
  namespace: string | null,
): Promise<MetafieldRecord[]> {
  const loader = loaders.get<string, MetafieldRecord[]>(
    `catalog.metafields.${owner.type}.${namespace ?? ''}`,
    (ids) => service.ofOwners(tenant, owner.type, ids, namespace),
  );
  return (await loader.load(owner.id)) ?? [];
}

/** Metafields set and deleted, and the shop's definitions (CAT-06, ADR-489). */
@Resolver()
export class MetafieldResolver {
  constructor(private readonly service: MetafieldService) {}

  @Mutation(() => MetafieldsSetPayload, {
    description:
      'Sets metafields on products, variants and collections, up to 25, all or none, as ' +
      "Shopify's metafieldsSet: each made or changed in place, of its type, or its definition's.",
  })
  @RequireScopes('write_products')
  async metafieldsSet(
    @CurrentTenant() tenant: TenantContext,
    @Args('metafields', { type: () => [MetafieldsSetInput] }) metafields: MetafieldsSetInput[],
  ): Promise<MetafieldsSetPayload> {
    const owners = metafields.map((input) => ownerOf(input.ownerId));
    const missing = owners.findIndex((owner) => owner === null);
    const result =
      missing >= 0
        ? failOne<MetafieldRecord[]>(
            ['metafields', String(missing), 'ownerId'],
            'NOT_FOUND',
            NO_OWNER,
          )
        : await this.service.set(
            tenant,
            metafields.map((input, index) => ({
              owner: owners[index]!,
              namespace: input.namespace,
              key: input.key,
              type: input.type ?? null,
              value: input.value,
            })),
          );
    return Object.assign(new MetafieldsSetPayload(), {
      metafields: result.ok ? result.value.map(toMetafield) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Mutation(() => MetafieldsDeletePayload, {
    description: 'Deletes metafields, up to 25, by their owner, namespace and key.',
  })
  @RequireScopes('write_products')
  async metafieldsDelete(
    @CurrentTenant() tenant: TenantContext,
    @Args('metafields', { type: () => [MetafieldIdentifierInput] })
    metafields: MetafieldIdentifierInput[],
  ): Promise<MetafieldsDeletePayload> {
    const named = metafields.flatMap((input) => {
      const owner = ownerOf(input.ownerId);
      return owner ? [{ owner, namespace: input.namespace, key: input.key }] : [];
    });
    const result = await this.service.delete(tenant, named);
    return Object.assign(new MetafieldsDeletePayload(), {
      deletedMetafields: result.ok
        ? result.value.map((each) =>
            Object.assign(new MetafieldIdentifier(), {
              ownerId: toPublicId(KIND[each.owner.type], each.owner.id),
              namespace: each.namespace,
              key: each.key,
            }),
          )
        : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Query(() => [MetafieldDefinition], {
    description: "The shop's metafield definitions, of a kind of owner or all, by name.",
  })
  @RequireScopes('read_products')
  async metafieldDefinitions(
    @CurrentTenant() tenant: TenantContext,
    @Args('ownerType', { type: () => MetafieldOwnerTypeValue, nullable: true })
    ownerType?: MetafieldOwnerTypeValue | null,
  ): Promise<MetafieldDefinition[]> {
    return (await this.service.definitions(tenant, ownerType ?? null)).map(toDefinition);
  }

  @Mutation(() => MetafieldDefinitionCreatePayload)
  @RequireScopes('write_products')
  async metafieldDefinitionCreate(
    @CurrentTenant() tenant: TenantContext,
    @Args('definition') definition: MetafieldDefinitionInput,
  ): Promise<MetafieldDefinitionCreatePayload> {
    const result = await this.service.createDefinition(tenant, {
      ownerType: definition.ownerType,
      namespace: definition.namespace,
      key: definition.key,
      type: definition.type,
      name: definition.name,
      description: definition.description ?? null,
    });
    return Object.assign(new MetafieldDefinitionCreatePayload(), {
      createdDefinition: result.ok ? toDefinition(result.value) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Mutation(() => MetafieldDefinitionUpdatePayload, {
    description: 'Renames a definition or changes its description; its type and key stay.',
  })
  @RequireScopes('write_products')
  async metafieldDefinitionUpdate(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
    @Args('definition') definition: MetafieldDefinitionUpdateInput,
  ): Promise<MetafieldDefinitionUpdatePayload> {
    const definitionId = tryFromPublicId(id, 'metafieldDefinition');
    const result = definitionId
      ? await this.service.updateDefinition(tenant, definitionId, {
          ...('name' in definition && { name: definition.name ?? null }),
          ...('description' in definition && { description: definition.description ?? null }),
        })
      : failOne<MetafieldDefinitionRecord>(['id'], 'NOT_FOUND', NO_DEFINITION);
    return Object.assign(new MetafieldDefinitionUpdatePayload(), {
      updatedDefinition: result.ok ? toDefinition(result.value) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Mutation(() => MetafieldDefinitionDeletePayload, {
    description:
      'Deletes a definition; with `deleteAllAssociatedMetafields`, its values on every owner ' +
      'of its kind too.',
  })
  @RequireScopes('write_products')
  async metafieldDefinitionDelete(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
    @Args('deleteAllAssociatedMetafields', { nullable: true, defaultValue: false })
    deleteAll: boolean,
  ): Promise<MetafieldDefinitionDeletePayload> {
    const definitionId = tryFromPublicId(id, 'metafieldDefinition');
    const result = definitionId
      ? await this.service.deleteDefinition(tenant, definitionId, deleteAll)
      : failOne<string>(['id'], 'NOT_FOUND', NO_DEFINITION);
    return Object.assign(new MetafieldDefinitionDeletePayload(), {
      deletedDefinitionId: result.ok ? id : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }
}

@Resolver(() => Product)
export class ProductMetafieldResolver {
  constructor(private readonly service: MetafieldService) {}

  @ResolveField('metafields', () => [Metafield], {
    description: 'Its metafields, by namespace and key; in one namespace, if given (ADR-489).',
  })
  @RequireScopes('read_products')
  async productMetafields(
    @CurrentTenant() tenant: TenantContext,
    @Loaders() loaders: RequestLoaders,
    @Parent() product: Product,
    @Args('namespace', { type: () => String, nullable: true }) namespace?: string | null,
  ): Promise<Metafield[]> {
    const owner = ownerOf(product.id)!;
    return (await metafieldsOf(this.service, tenant, loaders, owner, namespace ?? null)).map(
      toMetafield,
    );
  }

  @ResolveField('metafield', () => Metafield, { nullable: true })
  @RequireScopes('read_products')
  async productMetafield(
    @CurrentTenant() tenant: TenantContext,
    @Loaders() loaders: RequestLoaders,
    @Parent() product: Product,
    @Args('namespace') namespace: string,
    @Args('key') key: string,
  ): Promise<Metafield | null> {
    const owner = ownerOf(product.id)!;
    const found = (await metafieldsOf(this.service, tenant, loaders, owner, null)).find(
      (each) => each.namespace === namespace && each.key === key,
    );
    return found ? toMetafield(found) : null;
  }
}

@Resolver(() => ProductVariant)
export class VariantMetafieldResolver {
  constructor(private readonly service: MetafieldService) {}

  @ResolveField('metafields', () => [Metafield], {
    description: 'Its metafields, by namespace and key; in one namespace, if given (ADR-489).',
  })
  @RequireScopes('read_products')
  async variantMetafields(
    @CurrentTenant() tenant: TenantContext,
    @Loaders() loaders: RequestLoaders,
    @Parent() variant: ProductVariant,
    @Args('namespace', { type: () => String, nullable: true }) namespace?: string | null,
  ): Promise<Metafield[]> {
    const owner = ownerOf(variant.id)!;
    return (await metafieldsOf(this.service, tenant, loaders, owner, namespace ?? null)).map(
      toMetafield,
    );
  }

  @ResolveField('metafield', () => Metafield, { nullable: true })
  @RequireScopes('read_products')
  async variantMetafield(
    @CurrentTenant() tenant: TenantContext,
    @Loaders() loaders: RequestLoaders,
    @Parent() variant: ProductVariant,
    @Args('namespace') namespace: string,
    @Args('key') key: string,
  ): Promise<Metafield | null> {
    const owner = ownerOf(variant.id)!;
    const found = (await metafieldsOf(this.service, tenant, loaders, owner, null)).find(
      (each) => each.namespace === namespace && each.key === key,
    );
    return found ? toMetafield(found) : null;
  }
}

@Resolver(() => Collection)
export class CollectionMetafieldResolver {
  constructor(private readonly service: MetafieldService) {}

  @ResolveField('metafields', () => [Metafield], {
    description: 'Its metafields, by namespace and key; in one namespace, if given (ADR-489).',
  })
  @RequireScopes('read_products')
  async collectionMetafields(
    @CurrentTenant() tenant: TenantContext,
    @Loaders() loaders: RequestLoaders,
    @Parent() collection: Collection,
    @Args('namespace', { type: () => String, nullable: true }) namespace?: string | null,
  ): Promise<Metafield[]> {
    const owner = ownerOf(collection.id)!;
    return (await metafieldsOf(this.service, tenant, loaders, owner, namespace ?? null)).map(
      toMetafield,
    );
  }

  @ResolveField('metafield', () => Metafield, { nullable: true })
  @RequireScopes('read_products')
  async collectionMetafield(
    @CurrentTenant() tenant: TenantContext,
    @Loaders() loaders: RequestLoaders,
    @Parent() collection: Collection,
    @Args('namespace') namespace: string,
    @Args('key') key: string,
  ): Promise<Metafield | null> {
    const owner = ownerOf(collection.id)!;
    const found = (await metafieldsOf(this.service, tenant, loaders, owner, null)).find(
      (each) => each.namespace === namespace && each.key === key,
    );
    return found ? toMetafield(found) : null;
  }
}
