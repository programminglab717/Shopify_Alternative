import { UserError } from '@hatti/api';
import { Field, ID, ObjectType } from '@nestjs/graphql';

@ObjectType({
  description:
    'A product on pre-order (CAT-14): it sells whatever its stock, and orders placed now keep ' +
    'the day it ships by.',
})
export class ProductPreorder {
  @Field(() => ID)
  productId!: string;

  @Field({ description: 'The day the shop promises to send what is ordered now, YYYY-MM-DD.' })
  shipsOn!: string;
}

@ObjectType()
export class ProductPreorderSetPayload {
  @Field(() => ProductPreorder, {
    nullable: true,
    description: 'Null once the product is off pre-order, or when there were errors.',
  })
  preorder!: ProductPreorder | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}
