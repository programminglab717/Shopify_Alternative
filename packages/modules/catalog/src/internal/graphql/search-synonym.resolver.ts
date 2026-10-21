import { CurrentTenant, RequireScopes, UserError, type TenantContext } from '@hatti/api';
import { Args, Field, InputType, Mutation, ObjectType, Query, Resolver } from '@nestjs/graphql';
import { SEARCH_SYNONYM_LIMITS, SearchSynonymService } from '../search-synonyms.js';

@ObjectType({
  description:
    "Words that mean the same to the shop's shoppers (SRC-04, ADR-685): a storefront's search " +
    'finds what holds any of them for any, beside the words Hatti knows mean the same.',
})
export class SearchSynonymGroup {
  @Field(() => [String], { description: 'Two to ten words, as the shop wrote them.' })
  words!: string[];
}

@InputType()
export class SearchSynonymGroupInput {
  @Field(() => [String], {
    description:
      `Two to ${SEARCH_SYNONYM_LIMITS.words} words that mean the same, each one word of ` +
      `${SEARCH_SYNONYM_LIMITS.word} characters at most, in no other group.`,
  })
  words!: string[];
}

@ObjectType()
export class SearchSynonymsSetPayload {
  @Field(() => [SearchSynonymGroup], {
    nullable: true,
    description: "The shop's groups now; null when they were refused.",
  })
  searchSynonyms!: SearchSynonymGroup[] | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

const toGroup = (group: { words: string[] }) =>
  Object.assign(new SearchSynonymGroup(), { words: group.words });

/** A shop's own search synonyms (SRC-04, ADR-685): read and changed as products are. */
@Resolver()
export class SearchSynonymResolver {
  constructor(private readonly service: SearchSynonymService) {}

  @Query(() => [SearchSynonymGroup], {
    description: "The shop's own groups of words that mean the same, in its order (ADR-685).",
  })
  @RequireScopes('read_products')
  async searchSynonyms(@CurrentTenant() tenant: TenantContext): Promise<SearchSynonymGroup[]> {
    return (await this.service.list(tenant)).map(toGroup);
  }

  @Mutation(() => SearchSynonymsSetPayload, {
    description:
      `Replaces the shop's groups of words that mean the same, ${SEARCH_SYNONYM_LIMITS.groups} ` +
      'at most; none takes them all away. Searches find by them at once; pages the edge keeps ' +
      'for a minute show them after it.',
  })
  @RequireScopes('write_products')
  async searchSynonymsSet(
    @CurrentTenant() tenant: TenantContext,
    @Args('groups', { type: () => [SearchSynonymGroupInput] }) groups: SearchSynonymGroupInput[],
  ): Promise<SearchSynonymsSetPayload> {
    const result = await this.service.set(
      tenant,
      groups.map((group) => group.words),
    );
    return Object.assign(new SearchSynonymsSetPayload(), {
      searchSynonyms: result.ok ? result.value.map(toGroup) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }
}
