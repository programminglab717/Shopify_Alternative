import { CurrentTenant, RequireScopes, UserError, failOne, type TenantContext } from '@hatti/api';
import { toPublicId, tryFromPublicId } from '@hatti/ids';
import { Args, Field, ID, Mutation, ObjectType, Query, Resolver } from '@nestjs/graphql';
import type { ProductRecord } from '../records.js';
import { SEARCH_RULE_LIMITS, SearchRuleService, type SearchRuleRecord } from '../search-rules.js';
import { toProduct } from './mappers.js';
import { Product } from './product.types.js';

@ObjectType({
  description:
    "What a storefront's search shows first, or leaves out, for a term (SRC-04, ADR-692): a " +
    'search whose words fold to the same as the term shows its pinned products first, in their ' +
    'order, whether they hold the words or not, and none of its hidden products.',
})
export class SearchRule {
  @Field(() => ID)
  id!: string;

  @Field({ description: 'The term as the shop wrote it.' })
  query!: string;

  @Field(() => [Product], {
    description: 'Shown first, in this order: those the shop still has. Drafts are not shown.',
  })
  pinnedProducts!: Product[];

  @Field(() => [Product], { description: 'Left out: those the shop still has.' })
  hiddenProducts!: Product[];

  @Field()
  updatedAt!: Date;
}

@ObjectType()
export class SearchRuleSetPayload {
  @Field(() => SearchRule, { nullable: true, description: 'The rule now; null when refused.' })
  searchRule!: SearchRule | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class SearchRuleDeletePayload {
  @Field(() => ID, { nullable: true })
  deletedSearchRuleId!: string | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

/** An ID of no product, which the service says is not found where it is. */
const NO_PRODUCT = '00000000-0000-0000-0000-000000000000';

/** What a shop's search shows first or leaves out, term by term (SRC-04, ADR-692). */
@Resolver(() => SearchRule)
export class SearchRuleResolver {
  constructor(private readonly service: SearchRuleService) {}

  /** The rules with their products, loaded together. */
  private async toRules(
    tenant: TenantContext,
    records: readonly SearchRuleRecord[],
  ): Promise<SearchRule[]> {
    const products = await this.service.productsOf(
      tenant,
      records.flatMap((record) => [...record.pinned, ...record.hidden]),
    );
    const shown = (ids: readonly string[]) =>
      ids
        .map((id) => products.get(id))
        .filter((record): record is ProductRecord => record !== undefined)
        .map((record) => toProduct(record, tenant.currency));
    return records.map((record) =>
      Object.assign(new SearchRule(), {
        id: toPublicId('searchRule', record.id),
        query: record.query,
        pinnedProducts: shown(record.pinned),
        hiddenProducts: shown(record.hidden),
        updatedAt: record.updatedAt,
      }),
    );
  }

  @Query(() => [SearchRule], {
    description: "The shop's search rules, by their terms (ADR-692).",
  })
  @RequireScopes('read_products')
  async searchRules(@CurrentTenant() tenant: TenantContext): Promise<SearchRule[]> {
    return this.toRules(tenant, await this.service.list(tenant));
  }

  @Mutation(() => SearchRuleSetPayload, {
    description:
      `Pins up to ${SEARCH_RULE_LIMITS.pinned} products to the top of a term's search, in ` +
      `their order, and hides up to ${SEARCH_RULE_LIMITS.hidden} from it, in place of what its ` +
      `rule said; a shop keeps rules for ${SEARCH_RULE_LIMITS.rules} terms. Searches show them ` +
      'at once; pages the edge keeps for a minute show them after it.',
  })
  @RequireScopes('write_products')
  async searchRuleSet(
    @CurrentTenant() tenant: TenantContext,
    @Args('query') query: string,
    @Args('pinnedProductIds', { type: () => [ID] }) pinnedProductIds: string[],
    @Args('hiddenProductIds', { type: () => [ID] }) hiddenProductIds: string[],
  ): Promise<SearchRuleSetPayload> {
    const uuids = (ids: string[]) => ids.map((id) => tryFromPublicId(id, 'product') ?? NO_PRODUCT);
    const result = await this.service.set(
      tenant,
      query,
      uuids(pinnedProductIds),
      uuids(hiddenProductIds),
    );
    return Object.assign(new SearchRuleSetPayload(), {
      searchRule: result.ok ? (await this.toRules(tenant, [result.value]))[0]! : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Mutation(() => SearchRuleDeletePayload, {
    description: "Takes a term's rule away: its search shows what it finds.",
  })
  @RequireScopes('write_products')
  async searchRuleDelete(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<SearchRuleDeletePayload> {
    const ruleId = tryFromPublicId(id, 'searchRule');
    const result = ruleId
      ? await this.service.delete(tenant, ruleId)
      : failOne<string>(['id'], 'NOT_FOUND', 'Search rule not found');
    return Object.assign(new SearchRuleDeletePayload(), {
      deletedSearchRuleId: result.ok ? id : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }
}
