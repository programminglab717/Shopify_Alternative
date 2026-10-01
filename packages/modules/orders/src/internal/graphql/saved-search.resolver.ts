import {
  CurrentTenant,
  PageInfo,
  RequireScopes,
  UserError,
  accessDenied,
  encodeCursor,
  hasScope,
  pageSize,
  type AccessScope,
  type TenantContext,
} from '@hatti/api';
import { toPublicId } from '@hatti/ids';
import { Args, Int, Mutation, Query, Resolver } from '@nestjs/graphql';
import type { SavedSearchRecord } from '../records.js';
import { SavedSearchService, parseSavedSearch } from '../saved-search.service.js';
import type { SavedSearchTypeValue } from '../schema.js';
import { cursorAfter, uuidOf } from './mappers.js';
import {
  SavedSearch,
  SavedSearchConnection,
  SavedSearchCreateInput,
  SavedSearchCreatePayload,
  SavedSearchDeleteInput,
  SavedSearchDeletePayload,
  SavedSearchEdge,
  SavedSearchUpdateInput,
  SavedSearchUpdatePayload,
  SearchFilter,
  SearchResultType,
} from './saved-search.types.js';

const TYPE_VALUES: Record<SearchResultType, SavedSearchTypeValue> = {
  [SearchResultType.ORDER]: 'order',
  [SearchResultType.DRAFT_ORDER]: 'draft_order',
  [SearchResultType.PRODUCT]: 'product',
};

const RESULT_TYPES: Record<SavedSearchTypeValue, SearchResultType> = {
  order: SearchResultType.ORDER,
  draft_order: SearchResultType.DRAFT_ORDER,
  product: SearchResultType.PRODUCT,
};

/** What keeping a saved search of each list needs, as changing the list itself does. */
const WRITE_SCOPES: Record<SavedSearchTypeValue, AccessScope> = {
  order: 'write_orders',
  draft_order: 'write_orders',
  product: 'write_products',
};

const pageArgs = [
  'first',
  { type: () => Int, nullable: true, description: '1 to 250; default 50.' },
] as const;

/**
 * Saved searches of the shop's lists (ORD-01, ADR-119, ADR-124), as Shopify's Admin API gives
 * them: orderSavedSearches, draftOrderSavedSearches and productSavedSearches, and savedSearchCreate,
 * savedSearchUpdate and savedSearchDelete for any of them, with the scopes its list needs.
 */
@Resolver()
export class SavedSearchResolver {
  constructor(private readonly searches: SavedSearchService) {}

  @Query(() => SavedSearchConnection, {
    description: "The shop's saved searches of its orders, oldest first, as their tabs were added.",
  })
  @RequireScopes('read_orders')
  orderSavedSearches(
    @CurrentTenant() tenant: TenantContext,
    @Args(...pageArgs) first: number | null,
    @Args('after', { type: () => String, nullable: true }) after: string | null,
  ): Promise<SavedSearchConnection> {
    return this.#list(tenant, 'order', first, after);
  }

  @Query(() => SavedSearchConnection, {
    description: "The shop's saved searches of its drafts, oldest first, as their tabs were added.",
  })
  @RequireScopes('read_orders')
  draftOrderSavedSearches(
    @CurrentTenant() tenant: TenantContext,
    @Args(...pageArgs) first: number | null,
    @Args('after', { type: () => String, nullable: true }) after: string | null,
  ): Promise<SavedSearchConnection> {
    return this.#list(tenant, 'draft_order', first, after);
  }

  @Query(() => SavedSearchConnection, {
    description:
      "The shop's saved searches of its products, oldest first, as their tabs were added.",
  })
  @RequireScopes('read_products')
  productSavedSearches(
    @CurrentTenant() tenant: TenantContext,
    @Args(...pageArgs) first: number | null,
    @Args('after', { type: () => String, nullable: true }) after: string | null,
  ): Promise<SavedSearchConnection> {
    return this.#list(tenant, 'product', first, after);
  }

  @Mutation(() => SavedSearchCreatePayload, {
    description:
      "Keeps a search of one of the shop's lists by name, for all its staff: up to 100 of each " +
      'list. Needs the scope that changes the list: write_orders, or write_products.',
  })
  async savedSearchCreate(
    @CurrentTenant() tenant: TenantContext,
    @Args('input') input: SavedSearchCreateInput,
  ): Promise<SavedSearchCreatePayload> {
    const resourceType = TYPE_VALUES[input.resourceType];
    requireWrite(tenant, resourceType);
    const result = await this.searches.create(tenant, {
      resourceType,
      name: input.name,
      query: input.query,
    });
    return Object.assign(new SavedSearchCreatePayload(), {
      savedSearch: result.ok ? toSavedSearch(result.value) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Mutation(() => SavedSearchUpdatePayload, {
    description:
      'Renames a saved search, or changes its query, checked by its list; it keeps its place.',
  })
  async savedSearchUpdate(
    @CurrentTenant() tenant: TenantContext,
    @Args('input') input: SavedSearchUpdateInput,
  ): Promise<SavedSearchUpdatePayload> {
    const id = uuidOf('savedSearch', input.id);
    await this.#requireWriteOf(tenant, id);
    const result = await this.searches.update(tenant, id, {
      ...(input.name !== undefined && { name: input.name }),
      ...(input.query !== undefined && { query: input.query }),
    });
    return Object.assign(new SavedSearchUpdatePayload(), {
      savedSearch: result.ok ? toSavedSearch(result.value) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Mutation(() => SavedSearchDeletePayload, { description: 'Deletes a saved search.' })
  async savedSearchDelete(
    @CurrentTenant() tenant: TenantContext,
    @Args('input') input: SavedSearchDeleteInput,
  ): Promise<SavedSearchDeletePayload> {
    const id = uuidOf('savedSearch', input.id);
    await this.#requireWriteOf(tenant, id);
    const result = await this.searches.delete(tenant, id);
    return Object.assign(new SavedSearchDeletePayload(), {
      deletedSavedSearchId: result.ok ? input.id : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  async #list(
    tenant: TenantContext,
    resourceType: SavedSearchTypeValue,
    first: number | null,
    after: string | null,
  ): Promise<SavedSearchConnection> {
    const { items, hasNextPage } = await this.searches.list(tenant, resourceType, {
      first: pageSize(first),
      after: cursorAfter(after),
    });
    const nodes = items.map(toSavedSearch);
    const edges = nodes.map((node, index) =>
      Object.assign(new SavedSearchEdge(), {
        node,
        cursor: encodeCursor({ id: items[index]!.id }),
      }),
    );
    return Object.assign(new SavedSearchConnection(), {
      edges,
      nodes,
      pageInfo: Object.assign(new PageInfo(), {
        hasNextPage,
        endCursor: edges.at(-1)?.cursor ?? null,
      }),
    });
  }

  /**
   * Refuses a caller without the scope the saved search's list needs. One the shop has none of by
   * that ID is left to the service, which says it is not found.
   */
  async #requireWriteOf(tenant: TenantContext, id: string): Promise<void> {
    const resourceType = await this.searches.resourceTypeOf(tenant, id);
    if (resourceType) requireWrite(tenant, resourceType);
  }
}

function requireWrite(tenant: TenantContext, resourceType: SavedSearchTypeValue): void {
  const scope = WRITE_SCOPES[resourceType];
  if (!hasScope(tenant, scope)) throw accessDenied([scope]);
}

function toSavedSearch(record: SavedSearchRecord): SavedSearch {
  // Saved searches are checked by their lists when saved, so their queries read.
  const search = parseSavedSearch(record.resourceType, record.query);
  const { filters, terms } = search.ok ? search.value : { filters: [], terms: record.query };
  return Object.assign(new SavedSearch(), {
    id: toPublicId('savedSearch', record.id),
    name: record.name,
    query: record.query,
    resourceType: RESULT_TYPES[record.resourceType],
    searchTerms: terms,
    filters: filters.map((filter) =>
      Object.assign(new SearchFilter(), {
        key: filter.negated ? `-${filter.key}` : filter.key,
        value: filter.value,
      }),
    ),
  });
}
