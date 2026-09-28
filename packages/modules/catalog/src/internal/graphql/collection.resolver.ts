import {
  CurrentTenant,
  RequireScopes,
  badUserInput,
  decodeCursor,
  encodeCursor,
  pageSize,
  type TenantContext,
} from '@hatti/api';
import { toPublicId } from '@hatti/ids';
import { Args, ID, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import type { RuleColumn, RuleRelation } from '../collection-rules.js';
import {
  CollectionService,
  InvalidCursorError,
  type CollectionCursor,
  type CollectionRuleSetInput as RuleSetValue,
} from '../collection.service.js';
import type { MutationResult } from '../input-checker.js';
import type { CollectionRecord } from '../records.js';
import {
  Collection,
  CollectionCreateInput,
  CollectionDeleteInput,
  CollectionDeletePayload,
  CollectionPayload,
  CollectionRuleSetInput,
  CollectionUpdateInput,
  CollectionsArgs,
  CollectionConnection,
} from './collection.types.js';
import {
  toCollection,
  toCollectionConnection,
  toProduct,
  toProductConnection,
  toSortOrderValue,
  toUserErrors,
  uuidOf,
} from './mappers.js';
import { MoveInput, PageArgs, ProductConnection } from './product.types.js';

function toRuleSet(
  input: CollectionRuleSetInput | null | undefined,
): RuleSetValue | null | undefined {
  if (input === null || input === undefined) return input;
  return {
    appliedDisjunctively: input.appliedDisjunctively,
    rules: input.rules.map((rule) => ({
      column: rule.column.toLowerCase() as RuleColumn,
      relation: rule.relation.toLowerCase() as RuleRelation,
      condition: rule.condition,
    })),
  };
}

function payload(result: MutationResult<CollectionRecord>): CollectionPayload {
  return Object.assign(new CollectionPayload(), {
    collection: result.ok ? toCollection(result.value) : null,
    userErrors: result.ok ? [] : toUserErrors(result.errors),
  });
}

/** A cursor within a collection: the product and its sort key ('' when the order has none). */
function encodeProductCursor(cursor: CollectionCursor): string {
  return encodeCursor({ id: toPublicId('product', cursor.id), k: cursor.key ?? '' });
}

function decodeProductCursor(cursor: string): CollectionCursor {
  const { id, k } = decodeCursor(cursor, ['id', 'k']);
  return { id: uuidOf('product', id), key: k === '' ? null : k };
}

@Resolver(() => Collection)
export class CollectionResolver {
  constructor(private readonly service: CollectionService) {}

  @Query(() => Collection, { nullable: true, description: 'A collection by ID, or null.' })
  @RequireScopes('read_products')
  async collection(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<Collection | null> {
    const record = await this.service.get(tenant, uuidOf('collection', id));
    return record ? toCollection(record) : null;
  }

  @Query(() => Collection, { nullable: true, description: 'A collection by handle, or null.' })
  @RequireScopes('read_products')
  async collectionByHandle(
    @CurrentTenant() tenant: TenantContext,
    @Args('handle') handle: string,
  ): Promise<Collection | null> {
    const record = await this.service.getByHandle(tenant, handle);
    return record ? toCollection(record) : null;
  }

  @Query(() => CollectionConnection, { description: 'Collections, newest first.' })
  @RequireScopes('read_products')
  async collections(
    @CurrentTenant() tenant: TenantContext,
    @Args() args: CollectionsArgs,
  ): Promise<CollectionConnection> {
    const after = args.after ? uuidOf('collection', decodeCursor(args.after, ['id']).id) : null;
    const { items, hasNextPage } = await this.service.list(tenant, {
      first: pageSize(args.first),
      after,
      query: args.query,
    });
    return toCollectionConnection(items, hasNextPage);
  }

  @ResolveField(() => ProductConnection, {
    description: "The products, in the collection's order.",
  })
  async products(
    @CurrentTenant() tenant: TenantContext,
    @Parent() collection: Collection,
    @Args() args: PageArgs,
  ): Promise<ProductConnection> {
    const page = await this.service
      .products(tenant, uuidOf('collection', collection.id), {
        first: pageSize(args.first),
        after: args.after ? decodeProductCursor(args.after) : null,
      })
      .catch((error: unknown) => {
        throw error instanceof InvalidCursorError ? badUserInput('Invalid cursor') : error;
      });
    if (!page) return toProductConnection([], [], false);
    return toProductConnection(
      page.items.map((item) => toProduct(item, tenant.currency)),
      page.cursors.map(encodeProductCursor),
      page.hasNextPage,
    );
  }

  @Mutation(() => CollectionPayload)
  @RequireScopes('write_products')
  async collectionCreate(
    @CurrentTenant() tenant: TenantContext,
    @Args('input') input: CollectionCreateInput,
  ): Promise<CollectionPayload> {
    return payload(
      await this.service.create(tenant, {
        title: input.title,
        handle: input.handle,
        description: input.description,
        sortOrder: input.sortOrder ? toSortOrderValue(input.sortOrder) : null,
        ruleSet: toRuleSet(input.ruleSet),
        productIds: input.products?.map((id) => uuidOf('product', id)),
      }),
    );
  }

  @Mutation(() => CollectionPayload)
  @RequireScopes('write_products')
  async collectionUpdate(
    @CurrentTenant() tenant: TenantContext,
    @Args('input') input: CollectionUpdateInput,
  ): Promise<CollectionPayload> {
    return payload(
      await this.service.update(tenant, {
        id: uuidOf('collection', input.id),
        title: input.title,
        handle: input.handle,
        description: input.description,
        sortOrder:
          input.sortOrder === undefined
            ? undefined
            : input.sortOrder && toSortOrderValue(input.sortOrder),
        ruleSet: toRuleSet(input.ruleSet),
      }),
    );
  }

  @Mutation(() => CollectionDeletePayload, {
    description: 'Deletes a collection. Its products stay in the catalog.',
  })
  @RequireScopes('write_products')
  async collectionDelete(
    @CurrentTenant() tenant: TenantContext,
    @Args('input') input: CollectionDeleteInput,
  ): Promise<CollectionDeletePayload> {
    const result = await this.service.delete(tenant, uuidOf('collection', input.id));
    return Object.assign(new CollectionDeletePayload(), {
      deletedCollectionId: result.ok ? input.id : null,
      userErrors: result.ok ? [] : toUserErrors(result.errors),
    });
  }

  @Mutation(() => CollectionPayload, {
    description: 'Adds products to the end of a manual collection.',
  })
  @RequireScopes('write_products')
  async collectionAddProducts(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
    @Args('productIds', { type: () => [ID] }) productIds: string[],
  ): Promise<CollectionPayload> {
    return payload(
      await this.service.addProducts(
        tenant,
        uuidOf('collection', id),
        productIds.map((productId) => uuidOf('product', productId)),
      ),
    );
  }

  @Mutation(() => CollectionPayload, {
    description: 'Takes products out of a manual collection.',
  })
  @RequireScopes('write_products')
  async collectionRemoveProducts(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
    @Args('productIds', { type: () => [ID] }) productIds: string[],
  ): Promise<CollectionPayload> {
    return payload(
      await this.service.removeProducts(
        tenant,
        uuidOf('collection', id),
        productIds.map((productId) => uuidOf('product', productId)),
      ),
    );
  }

  @Mutation(() => CollectionPayload, {
    description: 'Moves products within a manual collection, one move after another.',
  })
  @RequireScopes('write_products')
  async collectionReorderProducts(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
    @Args('moves', { type: () => [MoveInput] }) moves: MoveInput[],
  ): Promise<CollectionPayload> {
    return payload(
      await this.service.reorderProducts(
        tenant,
        uuidOf('collection', id),
        moves.map((move) => ({ id: uuidOf('product', move.id), newPosition: move.newPosition })),
      ),
    );
  }
}
