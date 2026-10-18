import { CurrentTenant, RequireScopes, UserError, type TenantContext } from '@hatti/api';
import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import {
  StorefrontFiltersService,
  type StorefrontFilterView,
  type StorefrontFiltersView,
} from '../storefront-filters.service.js';
import {
  OnlineStoreFilters,
  OnlineStoreFiltersInput,
  OnlineStoreFiltersUpdatePayload,
  StorefrontFilter,
  StorefrontFilterKind,
} from './storefront-filters.types.js';

@Resolver(() => OnlineStoreFilters)
export class StorefrontFiltersResolver {
  constructor(private readonly service: StorefrontFiltersService) {}

  @Query(() => OnlineStoreFilters, {
    description:
      "The filters the storefront's collection and search pages show, and those the shop " +
      'could choose (ADR-568).',
  })
  @RequireScopes('read_settings')
  async onlineStoreFilters(@CurrentTenant() tenant: TenantContext): Promise<OnlineStoreFilters> {
    return toFilters(await this.service.get(tenant));
  }

  @Mutation(() => OnlineStoreFiltersUpdatePayload, {
    description:
      "Chooses the filters the storefront's collection and search pages show, in their order " +
      "and under the shop's words, or null for the platform's; the storefront shows them a " +
      "moment later. A page's filter.* parameters of filters not chosen are ignored.",
  })
  @RequireScopes('write_settings')
  async onlineStoreFiltersUpdate(
    @CurrentTenant() tenant: TenantContext,
    @Args('input') input: OnlineStoreFiltersInput,
  ): Promise<OnlineStoreFiltersUpdatePayload> {
    const result = await this.service.update(
      tenant,
      input.filters?.map((filter) => ({ ...filter, kind: filter.kind.toLowerCase() })) ?? null,
    );
    return Object.assign(new OnlineStoreFiltersUpdatePayload(), {
      onlineStoreFilters: result.ok ? toFilters(result.value) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }
}

function toFilters(view: StorefrontFiltersView): OnlineStoreFilters {
  return Object.assign(new OnlineStoreFilters(), {
    filters: view.filters && view.filters.map(toFilter),
    availableFilters: view.available.map(toFilter),
  });
}

function toFilter(filter: StorefrontFilterView): StorefrontFilter {
  return Object.assign(new StorefrontFilter(), {
    kind: filter.kind.toUpperCase() as StorefrontFilterKind,
    key: filter.key,
    label: filter.label,
    labelUr: filter.labelUr,
    defaultLabel: filter.defaultLabel,
    metafieldType: filter.metafieldType,
  });
}
