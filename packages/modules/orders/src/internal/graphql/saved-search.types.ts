import { PageInfo, UserError } from '@hatti/api';
import { Field, ID, InputType, ObjectType, registerEnumType } from '@nestjs/graphql';

/** The list a saved search searches (ADR-119, ADR-124), as Shopify names them. */
export enum SearchResultType {
  ORDER = 'ORDER',
  DRAFT_ORDER = 'DRAFT_ORDER',
  PRODUCT = 'PRODUCT',
}
registerEnumType(SearchResultType, {
  name: 'SearchResultType',
  description: 'The list a saved search searches: orders, drafts or products.',
});

@ObjectType({ description: "A filter of a saved search's query." })
export class SearchFilter {
  @Field({ description: 'With a leading minus for a filter that leaves its matches out.' })
  key!: string;

  @Field()
  value!: string;
}

@ObjectType({
  description:
    "A search the shop keeps by name, for all its staff, as Shopify's saved searches: pass its " +
    "query to its list's search, orders(query:), draftOrders(query:) or products(query:), to open " +
    'its view.',
})
export class SavedSearch {
  @Field(() => ID)
  id!: string;

  @Field({
    description: "As the tab it names shows it: unique among its list's, in any letter case.",
  })
  name!: string;

  @Field({ description: "The search, as its list's search takes it." })
  query!: string;

  @Field(() => SearchResultType)
  resourceType!: SearchResultType;

  @Field({ description: 'The words of the query, its filters aside.' })
  searchTerms!: string;

  @Field(() => [SearchFilter], { description: 'The filters of the query, in its order.' })
  filters!: SearchFilter[];
}

@ObjectType()
export class SavedSearchEdge {
  @Field()
  cursor!: string;

  @Field(() => SavedSearch)
  node!: SavedSearch;
}

@ObjectType()
export class SavedSearchConnection {
  @Field(() => [SavedSearchEdge])
  edges!: SavedSearchEdge[];

  @Field(() => [SavedSearch])
  nodes!: SavedSearch[];

  @Field(() => PageInfo)
  pageInfo!: PageInfo;
}

@InputType()
export class SavedSearchCreateInput {
  @Field({
    description: "Up to 40 characters, unique among its list's saved searches in any letter case.",
  })
  name!: string;

  @Field({
    description:
      "Up to 1,000 characters, as its list's search takes it: a filter or value that search " +
      'does not know is refused.',
  })
  query!: string;

  @Field(() => SearchResultType, {
    description:
      'The list it searches: ORDER and DRAFT_ORDER need write_orders, PRODUCT write_products.',
  })
  resourceType!: SearchResultType;
}

@InputType({ description: 'Fields left out stay as they are.' })
export class SavedSearchUpdateInput {
  @Field(() => ID)
  id!: string;

  @Field(() => String, { nullable: true })
  name?: string | null;

  @Field(() => String, { nullable: true })
  query?: string | null;
}

@InputType()
export class SavedSearchDeleteInput {
  @Field(() => ID)
  id!: string;
}

@ObjectType()
export class SavedSearchCreatePayload {
  @Field(() => SavedSearch, { nullable: true })
  savedSearch!: SavedSearch | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class SavedSearchUpdatePayload {
  @Field(() => SavedSearch, { nullable: true })
  savedSearch!: SavedSearch | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class SavedSearchDeletePayload {
  @Field(() => ID, { nullable: true })
  deletedSavedSearchId!: string | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}
