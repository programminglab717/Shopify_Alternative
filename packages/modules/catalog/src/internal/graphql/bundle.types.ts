import { UserError } from '@hatti/api';
import { Field, ID, InputType, Int, ObjectType } from '@nestjs/graphql';

@ObjectType({ description: 'A part of a bundle: a variant of another product, and how many.' })
export class ProductBundleComponent {
  @Field(() => ID)
  variantId!: string;

  @Field(() => ID)
  productId!: string;

  @Field()
  productTitle!: string;

  @Field()
  variantTitle!: string;

  @Field(() => Int, { description: 'How many of it one bundle holds, 1 to 99.' })
  quantity!: number;
}

@ObjectType({
  description:
    'A product sold as a set of other products’ variants (CAT-11, ADR-409): its one variant is ' +
    'what is ordered, its parts are what orders hold and what stock sells from.',
})
export class ProductBundle {
  @Field(() => ID)
  productId!: string;

  @Field(() => [ProductBundleComponent], { description: 'In the order the shop gave them.' })
  components!: ProductBundleComponent[];

  @Field({
    description:
      'False once a part’s variant was deleted: the bundle is not sold until it is given its ' +
      'parts again.',
  })
  complete!: boolean;
}

@InputType()
export class ProductBundleComponentInput {
  @Field(() => ID)
  variantId!: string;

  @Field(() => Int, { description: '1 to 99.' })
  quantity!: number;
}

@ObjectType()
export class ProductBundleSetPayload {
  @Field(() => ProductBundle, { nullable: true, description: 'Null once it is no bundle.' })
  bundle!: ProductBundle | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}
