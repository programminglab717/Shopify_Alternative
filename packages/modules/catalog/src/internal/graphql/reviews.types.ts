import { UserError } from '@hatti/api';
import { Field, GraphQLISODateTime, ID, Int, ObjectType, registerEnumType } from '@nestjs/graphql';

export enum ProductReviewStatus {
  PENDING = 'PENDING',
  PUBLISHED = 'PUBLISHED',
  HIDDEN = 'HIDDEN',
}

registerEnumType(ProductReviewStatus, {
  name: 'ProductReviewStatus',
  description:
    'PENDING until the shop publishes it, or at once when its stars reach those the shop ' +
    'publishes by itself; HIDDEN when the shop keeps it off its storefront. A customer changing ' +
    'what they said sends it back to PENDING, unless its stars publish it.',
});

@ObjectType({
  description:
    "A customer's stars, and words if they gave any, for a product of an order delivered to " +
    "them (MKT-05, ADR-399): one an order and product, written on their order's page.",
})
export class ProductReview {
  @Field(() => ID)
  id!: string;

  @Field(() => ID)
  productId!: string;

  @Field()
  productTitle!: string;

  @Field(() => ID, { description: 'The order it was written on.' })
  orderId!: string;

  @Field({ description: 'As the storefront shows it: "Ayesha K.", or "A customer".' })
  authorName!: string;

  @Field(() => Int, { description: '1 to 5.' })
  rating!: number;

  @Field(() => String, { nullable: true })
  body!: string | null;

  @Field(() => ProductReviewStatus)
  status!: ProductReviewStatus;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;

  @Field(() => GraphQLISODateTime, { description: 'When the customer last changed it.' })
  updatedAt!: Date;

  @Field(() => GraphQLISODateTime, { nullable: true })
  publishedAt!: Date | null;
}

@ObjectType()
export class ProductReviewPayload {
  @Field(() => ProductReview, { nullable: true })
  productReview!: ProductReview | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType({ description: "How the shop's reviews are published (ADR-399)." })
export class ReviewSettings {
  @Field(() => Int, {
    nullable: true,
    description:
      'Reviews of this many stars or more, 3, 4 or 5, publish by themselves; the rest wait for ' +
      'the shop. Null: every review waits.',
  })
  publishFrom!: number | null;
}

@ObjectType()
export class ReviewSettingsPayload {
  @Field(() => ReviewSettings, { nullable: true })
  reviewSettings!: ReviewSettings | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}
