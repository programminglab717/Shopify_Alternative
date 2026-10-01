import {
  CurrentTenant,
  PageInfo,
  RequireScopes,
  UserError,
  encodeCursor,
  pageSize,
  type TenantContext,
} from '@hatti/api';
import { toPublicId } from '@hatti/ids';
import { Args, Int, Mutation, Query, Resolver } from '@nestjs/graphql';
import { parseOrderSearch } from '../order-filter.js';
import type { SavedSearchRecord } from '../records.js';
import { SavedSearchService } from '../saved-search.service.js';
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

/**
 * Saved searches of the orders list (ORD-01, ADR-119), as Shopify's Admin API gives them:
 * orderSavedSearches, and savedSearchCreate, savedSearchUpdate and savedSearchDelete, for orders.
 */
@Resolver()
export class SavedSearchResolver {
  constructor(private readonly searches: SavedSearchService) {}

  @Query(() => SavedSearchConnection, {
    description: "The shop's saved searches of its orders, oldest first, as their tabs were added.",
  })
  @RequireScopes('read_orders')
  async orderSavedSearches(
    @CurrentTenant() tenant: TenantContext,
    @Args('first', { type: () => Int, nullable: true, description: '1 to 250; default 50.' })
    first: number | null,
    @Args('after', { type: () => String, nullable: true }) after: string | null,
  ): Promise<SavedSearchConnection> {
    const { items, hasNextPage } = await this.searches.list(tenant, {
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

  @Mutation(() => SavedSearchCreatePayload, {
    description:
      'Keeps a search of the orders by name, for all the shop’s staff: up to 100 a shop.',
  })
  @RequireScopes('write_orders')
  async savedSearchCreate(
    @CurrentTenant() tenant: TenantContext,
    @Args('input') input: SavedSearchCreateInput,
  ): Promise<SavedSearchCreatePayload> {
    const result = await this.searches.create(tenant, { name: input.name, query: input.query });
    return Object.assign(new SavedSearchCreatePayload(), {
      savedSearch: result.ok ? toSavedSearch(result.value) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Mutation(() => SavedSearchUpdatePayload, {
    description: 'Renames a saved search, or changes its query; it keeps its place.',
  })
  @RequireScopes('write_orders')
  async savedSearchUpdate(
    @CurrentTenant() tenant: TenantContext,
    @Args('input') input: SavedSearchUpdateInput,
  ): Promise<SavedSearchUpdatePayload> {
    const result = await this.searches.update(tenant, uuidOf('savedSearch', input.id), {
      ...(input.name !== undefined && { name: input.name }),
      ...(input.query !== undefined && { query: input.query }),
    });
    return Object.assign(new SavedSearchUpdatePayload(), {
      savedSearch: result.ok ? toSavedSearch(result.value) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Mutation(() => SavedSearchDeletePayload, { description: 'Deletes a saved search.' })
  @RequireScopes('write_orders')
  async savedSearchDelete(
    @CurrentTenant() tenant: TenantContext,
    @Args('input') input: SavedSearchDeleteInput,
  ): Promise<SavedSearchDeletePayload> {
    const result = await this.searches.delete(tenant, uuidOf('savedSearch', input.id));
    return Object.assign(new SavedSearchDeletePayload(), {
      deletedSavedSearchId: result.ok ? input.id : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }
}

function toSavedSearch(record: SavedSearchRecord): SavedSearch {
  // Saved searches are checked when saved, so their queries read.
  const search = parseOrderSearch(record.query);
  const { filters, terms } = search.ok ? search.value : { filters: [], terms: record.query };
  return Object.assign(new SavedSearch(), {
    id: toPublicId('savedSearch', record.id),
    name: record.name,
    query: record.query,
    resourceType: SearchResultType.ORDER,
    searchTerms: terms,
    filters: filters.map((filter) =>
      Object.assign(new SearchFilter(), {
        key: filter.negated ? `-${filter.key}` : filter.key,
        value: filter.value,
      }),
    ),
  });
}
