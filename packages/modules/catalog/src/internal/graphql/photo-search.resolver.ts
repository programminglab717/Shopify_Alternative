import { CurrentTenant, RequireScopes, type TenantContext } from '@hatti/api';
import { Args, Field, Int, Mutation, ObjectType, Query, Resolver } from '@nestjs/graphql';
import { PhotoSearchService } from '../photo-search.js';

@ObjectType({
  description:
    "Visual search (SRC-07, ADR-870): whether the shop's search reads a shopper's photo into a " +
    'search of its products, each photo one of its AI credits. The theme shows its camera button ' +
    "where the search section's setting asks.",
})
export class PhotoSearch {
  @Field({ description: 'Whether the shop reads shoppers’ photos.' })
  enabled!: boolean;

  @Field({ description: 'Whether Hatti has an AI to read them here.' })
  available!: boolean;

  @Field(() => Int, { description: 'Photos read in the last day.' })
  usedToday!: number;

  @Field(() => Int, { description: 'Photos a shop reads a day at most.' })
  limitPerDay!: number;
}

@Resolver(() => PhotoSearch)
export class PhotoSearchResolver {
  constructor(private readonly service: PhotoSearchService) {}

  @Query(() => PhotoSearch, { description: 'Whether the shop’s search reads shoppers’ photos.' })
  @RequireScopes('read_products')
  async photoSearch(@CurrentTenant() tenant: TenantContext): Promise<PhotoSearch> {
    return Object.assign(new PhotoSearch(), await this.service.setting(tenant));
  }

  @Mutation(() => PhotoSearch, {
    description:
      'Turns reading shoppers’ photos on or off. Each photo read spends one of the shop’s AI ' +
      'credits.',
  })
  @RequireScopes('write_settings')
  async photoSearchSet(
    @CurrentTenant() tenant: TenantContext,
    @Args('enabled') enabled: boolean,
  ): Promise<PhotoSearch> {
    return Object.assign(new PhotoSearch(), await this.service.set(tenant, enabled));
  }
}
