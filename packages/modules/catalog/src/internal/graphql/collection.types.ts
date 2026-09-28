import { PageInfo, UserError } from '@hatti/api';
import {
  ArgsType,
  Field,
  GraphQLISODateTime,
  ID,
  InputType,
  Int,
  ObjectType,
  registerEnumType,
} from '@nestjs/graphql';
import { PageArgs } from './product.types.js';

export enum CollectionSortOrder {
  MANUAL = 'MANUAL',
  ALPHA_ASC = 'ALPHA_ASC',
  ALPHA_DESC = 'ALPHA_DESC',
  PRICE_ASC = 'PRICE_ASC',
  PRICE_DESC = 'PRICE_DESC',
  CREATED = 'CREATED',
  CREATED_DESC = 'CREATED_DESC',
}

registerEnumType(CollectionSortOrder, {
  name: 'CollectionSortOrder',
  description: "The order of a collection's products.",
  valuesMap: {
    MANUAL: { description: 'As the merchant arranged them. Manual collections only.' },
    ALPHA_ASC: { description: 'By title, A to Z.' },
    ALPHA_DESC: { description: 'By title, Z to A.' },
    PRICE_ASC: { description: 'By lowest variant price, low to high.' },
    PRICE_DESC: { description: 'By highest variant price, high to low.' },
    CREATED: { description: 'Oldest first.' },
    CREATED_DESC: { description: 'Newest first. The default for smart collections.' },
  },
});

export enum CollectionRuleColumn {
  TITLE = 'TITLE',
  TYPE = 'TYPE',
  VENDOR = 'VENDOR',
  TAG = 'TAG',
  VARIANT_TITLE = 'VARIANT_TITLE',
  VARIANT_PRICE = 'VARIANT_PRICE',
  VARIANT_COMPARE_AT_PRICE = 'VARIANT_COMPARE_AT_PRICE',
  VARIANT_WEIGHT = 'VARIANT_WEIGHT',
  IS_PRICE_REDUCED = 'IS_PRICE_REDUCED',
}

registerEnumType(CollectionRuleColumn, {
  name: 'CollectionRuleColumn',
  description: 'What a smart collection rule looks at. Variant rules match if any variant does.',
  valuesMap: {
    VARIANT_PRICE: { description: 'A price in the shop currency, e.g. "2499".' },
    VARIANT_COMPARE_AT_PRICE: { description: 'A price in the shop currency.' },
    VARIANT_WEIGHT: { description: 'A weight in grams.' },
    IS_PRICE_REDUCED: { description: 'A compare-at price above the price: IS_SET or IS_NOT_SET.' },
  },
});

export enum CollectionRuleRelation {
  EQUALS = 'EQUALS',
  NOT_EQUALS = 'NOT_EQUALS',
  GREATER_THAN = 'GREATER_THAN',
  LESS_THAN = 'LESS_THAN',
  STARTS_WITH = 'STARTS_WITH',
  ENDS_WITH = 'ENDS_WITH',
  CONTAINS = 'CONTAINS',
  NOT_CONTAINS = 'NOT_CONTAINS',
  IS_SET = 'IS_SET',
  IS_NOT_SET = 'IS_NOT_SET',
}

registerEnumType(CollectionRuleRelation, {
  name: 'CollectionRuleRelation',
  description: 'How a rule compares. Text comparisons ignore case.',
});

@ObjectType({ description: 'A condition a product must meet to be in a smart collection.' })
export class CollectionRule {
  @Field(() => CollectionRuleColumn)
  column!: CollectionRuleColumn;

  @Field(() => CollectionRuleRelation)
  relation!: CollectionRuleRelation;

  @Field({ description: 'The value to compare with; empty for IS_SET and IS_NOT_SET.' })
  condition!: string;
}

@ObjectType()
export class CollectionRuleSet {
  @Field({ description: 'A product needs to meet any rule, rather than all of them.' })
  appliedDisjunctively!: boolean;

  @Field(() => [CollectionRule])
  rules!: CollectionRule[];
}

@ObjectType({
  description:
    'A group of products. Manual collections hold the products added to them; smart ' +
    'collections hold every product that meets their rules, kept up to date as products change.',
})
export class Collection {
  @Field(() => ID)
  id!: string;

  @Field()
  title!: string;

  @Field({ description: 'Unique, URL-safe name within the shop, e.g. "eid-collection".' })
  handle!: string;

  @Field()
  description!: string;

  @Field(() => CollectionSortOrder)
  sortOrder!: CollectionSortOrder;

  @Field(() => CollectionRuleSet, { nullable: true, description: 'Null for a manual collection.' })
  ruleSet!: CollectionRuleSet | null;

  @Field(() => Int)
  productsCount!: number;

  @Field(() => Int, { description: 'Starts at 1 and increases with every change.' })
  version!: number;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;

  @Field(() => GraphQLISODateTime)
  updatedAt!: Date;
}

@ObjectType()
export class CollectionEdge {
  @Field()
  cursor!: string;

  @Field(() => Collection)
  node!: Collection;
}

@ObjectType()
export class CollectionConnection {
  @Field(() => [CollectionEdge])
  edges!: CollectionEdge[];

  @Field(() => [Collection])
  nodes!: Collection[];

  @Field(() => PageInfo)
  pageInfo!: PageInfo;
}

@ArgsType()
export class CollectionsArgs extends PageArgs {
  @Field(() => String, { nullable: true, description: 'Words to find in the title.' })
  query?: string | null;
}

@InputType()
export class CollectionRuleInput {
  @Field(() => CollectionRuleColumn)
  column!: CollectionRuleColumn;

  @Field(() => CollectionRuleRelation)
  relation!: CollectionRuleRelation;

  @Field({ defaultValue: '' })
  condition!: string;
}

@InputType()
export class CollectionRuleSetInput {
  @Field({ defaultValue: false })
  appliedDisjunctively!: boolean;

  @Field(() => [CollectionRuleInput])
  rules!: CollectionRuleInput[];
}

@InputType()
export class CollectionCreateInput {
  @Field()
  title!: string;

  @Field(() => String, { nullable: true, description: 'Generated from the title if omitted.' })
  handle?: string | null;

  @Field(() => String, { nullable: true })
  description?: string | null;

  @Field(() => CollectionSortOrder, {
    nullable: true,
    description: 'Defaults to MANUAL, or CREATED_DESC for a smart collection.',
  })
  sortOrder?: CollectionSortOrder | null;

  @Field(() => CollectionRuleSetInput, {
    nullable: true,
    description: 'Makes a smart collection. A collection stays manual or smart.',
  })
  ruleSet?: CollectionRuleSetInput | null;

  @Field(() => [ID], {
    nullable: true,
    description: 'Manual collections: first products, in order.',
  })
  products?: string[] | null;
}

@InputType()
export class CollectionUpdateInput {
  @Field(() => ID)
  id!: string;

  @Field(() => String, { nullable: true })
  title?: string | null;

  @Field(() => String, { nullable: true })
  handle?: string | null;

  @Field(() => String, { nullable: true })
  description?: string | null;

  @Field(() => CollectionSortOrder, { nullable: true })
  sortOrder?: CollectionSortOrder | null;

  @Field(() => CollectionRuleSetInput, {
    nullable: true,
    description: 'Smart collections only: replaces the rules.',
  })
  ruleSet?: CollectionRuleSetInput | null;
}

@InputType()
export class CollectionDeleteInput {
  @Field(() => ID)
  id!: string;
}

@ObjectType()
export class CollectionPayload {
  @Field(() => Collection, { nullable: true })
  collection!: Collection | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class CollectionDeletePayload {
  @Field(() => ID, { nullable: true })
  deletedCollectionId!: string | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}
