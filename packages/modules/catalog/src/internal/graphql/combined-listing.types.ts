import { UserError } from '@hatti/api';
import { Field, GraphQLISODateTime, ID, InputType, ObjectType } from '@nestjs/graphql';
import { COMBINED_LISTING_LIMITS } from '../combined-listings.js';

@ObjectType({
  description: "A product of a combined listing, and its value of the listing's option.",
})
export class CombinedListingProduct {
  @Field(() => ID)
  productId!: string;

  @Field({ description: 'Its value of the option: "Maroon".' })
  value!: string;

  @Field(() => String, {
    nullable: true,
    description: 'Its value in Urdu (ADR-902), which Urdu pages show; null for none.',
  })
  valueUr!: string | null;
}

@ObjectType({
  description:
    'Products the shop shows as one listing (CAT-23, ADR-799), each a value of its option, as ' +
    "a print's colours are: each product's page offers the others as that option's other " +
    'values, linking to their pages. A product is in one listing at most.',
})
export class CombinedListing {
  @Field(() => ID)
  id!: string;

  @Field({ description: 'What its products differ by, as its pages name the option: "Colour".' })
  optionName!: string;

  @Field(() => String, {
    nullable: true,
    description: "The option's name in Urdu (ADR-902), which Urdu pages show; null for none.",
  })
  optionNameUr!: string | null;

  @Field(() => [CombinedListingProduct], { description: 'In the order its pages show them.' })
  products!: CombinedListingProduct[];

  @Field({
    description:
      'Whether collections show it as one card (ADR-901): the first of its products in each ' +
      "collection's order, its card naming the others' values; the others are left out there.",
  })
  oneCard!: boolean;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;

  @Field(() => GraphQLISODateTime)
  updatedAt!: Date;
}

@InputType()
export class CombinedListingProductInput {
  @Field(() => ID)
  productId!: string;

  @Field({ description: `Up to ${COMBINED_LISTING_LIMITS.value} characters, none of the others'.` })
  value!: string;

  @Field(() => String, {
    nullable: true,
    description: 'Its value in Urdu; left out, as it was for the product; null or blank, none.',
  })
  valueUr?: string | null;
}

@InputType()
export class CombinedListingInput {
  @Field({ description: `Up to ${COMBINED_LISTING_LIMITS.optionName} characters.` })
  optionName!: string;

  @Field(() => String, {
    nullable: true,
    description: "The option's name in Urdu; left out, as it was; null or blank, none.",
  })
  optionNameUr?: string | null;

  @Field(() => [CombinedListingProductInput], {
    description:
      `${COMBINED_LISTING_LIMITS.products.min} to ${COMBINED_LISTING_LIMITS.products.max} ` +
      'products, in the order its pages show them, each in no other listing.',
  })
  products!: CombinedListingProductInput[];

  @Field(() => Boolean, {
    nullable: true,
    description: 'Whether collections show it as one card; left out, as it was, or false.',
  })
  oneCard?: boolean | null;
}

@ObjectType()
export class CombinedListingPayload {
  @Field(() => CombinedListing, { nullable: true })
  combinedListing!: CombinedListing | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class CombinedListingDeletePayload {
  @Field(() => ID, { nullable: true })
  deletedCombinedListingId!: string | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}
